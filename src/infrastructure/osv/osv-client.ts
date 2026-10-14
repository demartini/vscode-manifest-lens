import { z } from "zod";

import {
  type AdvisoryPort,
  type AdvisoryQuery,
  advisoryKey,
} from "../../application/ports";
import type {
  Advisory,
  AdvisorySeverity,
  AffectedPackage,
} from "../../domain/vulnerability/advisory";
import { ManifestLensError, normalizeError } from "../../shared/errors";
import { type Result, err, ok } from "../../shared/result";
import { mapLimit } from "../../shared/utilities/concurrency";
import { TtlCache } from "../cache/ttl-cache";
import type { HttpClient } from "../http/http-client";
import { joinUrl, validateServiceUrl } from "../http/url";

export const OSV_BASE_URL = "https://api.osv.dev/";

export interface OsvSettings {
  readonly baseUrl: string;
  readonly cacheTtlMs: number;
  readonly concurrency: number;
}

const BATCH_SIZE = 1000;
const MAX_PAGES = 5;
const NEGATIVE_TTL_MS = 60_000;

const batchSchema = z.object({
  results: z.array(
    z.looseObject({
      next_page_token: z.string().optional(),
      vulns: z.array(z.looseObject({ id: z.string() })).optional(),
    })
  ),
});

const eventSchema = z.looseObject({
  fixed: z.string().optional(),
  introduced: z.string().optional(),
  last_affected: z.string().optional(),
  limit: z.string().optional(),
});

const vulnSchema = z.looseObject({
  affected: z
    .array(
      z.looseObject({
        package: z
          .looseObject({ ecosystem: z.string(), name: z.string() })
          .optional(),
        ranges: z
          .array(
            z.looseObject({
              events: z.array(eventSchema).default([]),
              type: z.string(),
            })
          )
          .optional(),
        versions: z.array(z.string()).optional(),
      })
    )
    .optional(),
  aliases: z.array(z.string()).optional(),
  database_specific: z
    .looseObject({ severity: z.string().optional() })
    .optional(),
  details: z.string().optional(),
  id: z.string(),
  modified: z.string().optional(),
  published: z.string().optional(),
  references: z
    .array(z.looseObject({ type: z.string().optional(), url: z.string() }))
    .optional(),
  summary: z.string().optional(),
  withdrawn: z.string().optional(),
});

const SEVERITIES: Readonly<Record<string, AdvisorySeverity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  LOW: "low",
  MEDIUM: "moderate",
  MODERATE: "moderate",
};

const isWebUrl = (value: string): boolean => /^https?:\/\//iu.test(value);

/** Converts a raw OSV record to the domain {@link Advisory}. Throws on invalid shapes. */
export function parseVulnerability(payload: unknown): Advisory {
  const parsed = vulnSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ManifestLensError(
      "invalid-response",
      "Unexpected OSV record shape.",
      {
        cause: parsed.error,
      }
    );
  }
  const vuln = parsed.data;
  const affected: AffectedPackage[] = (vuln.affected ?? []).flatMap((entry) =>
    entry.package
      ? [
          {
            ecosystem: entry.package.ecosystem,
            name: entry.package.name,
            ranges: (entry.ranges ?? []).map((range) => ({
              events: range.events.map((event) => ({
                ...(event.fixed === undefined ? {} : { fixed: event.fixed }),
                ...(event.introduced === undefined
                  ? {}
                  : { introduced: event.introduced }),
                ...(event.last_affected === undefined
                  ? {}
                  : { lastAffected: event.last_affected }),
                ...(event.limit === undefined ? {} : { limit: event.limit }),
              })),
              type: range.type,
            })),
            versions: entry.versions ?? [],
          },
        ]
      : []
  );
  const label = vuln.database_specific?.severity?.toUpperCase();
  const summary = vuln.summary ?? vuln.details?.split("\n")[0] ?? vuln.id;
  return {
    affected,
    aliases: vuln.aliases ?? [],
    ...(vuln.details === undefined ? {} : { details: vuln.details }),
    id: vuln.id,
    ...(vuln.modified === undefined ? {} : { modifiedAt: vuln.modified }),
    ...(vuln.published === undefined ? {} : { publishedAt: vuln.published }),
    references: (vuln.references ?? [])
      .filter((reference) => isWebUrl(reference.url))
      .map((reference) => ({
        type: reference.type ?? "WEB",
        url: reference.url,
      })),
    severity:
      (label === undefined ? undefined : SEVERITIES[label]) ?? "unknown",
    summary,
    ...(vuln.withdrawn === undefined ? {} : { withdrawnAt: vuln.withdrawn }),
  };
}

/** OSV access: batch id lookup followed by cached, de-duplicated record retrieval. */
export class OsvClient implements AdvisoryPort {
  private readonly queryCache: TtlCache<readonly string[]>;
  private readonly recordCache: TtlCache<Advisory>;
  private readonly http: HttpClient;
  private readonly settings: () => OsvSettings;

  constructor(options: {
    http: HttpClient;
    settings: () => OsvSettings;
    now?: () => number;
  }) {
    this.http = options.http;
    this.settings = options.settings;
    this.queryCache = new TtlCache(5000, options.now);
    this.recordCache = new TtlCache(5000, options.now);
  }

  clearCache(): void {
    this.queryCache.clear();
    this.recordCache.clear();
  }

  async query(
    queries: readonly AdvisoryQuery[],
    signal?: AbortSignal
  ): Promise<Map<string, Result<readonly Advisory[], ManifestLensError>>> {
    const out = new Map<
      string,
      Result<readonly Advisory[], ManifestLensError>
    >();
    const settings = this.settings();
    const unique = [
      ...new Map(queries.map((query) => [advisoryKey(query), query])).values(),
    ];
    const idsByKey = new Map<string, readonly string[]>();
    const pending: AdvisoryQuery[] = [];
    for (const query of unique) {
      const cached = this.queryCache.get(advisoryKey(query));
      if (cached) {
        idsByKey.set(advisoryKey(query), cached);
      } else {
        pending.push(query);
      }
    }

    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      const chunk = pending.slice(offset, offset + BATCH_SIZE);
      try {
        const ids = await this.queryChunk(chunk, settings, signal);
        for (const [index, query] of chunk.entries()) {
          const found = ids[index] ?? [];
          idsByKey.set(advisoryKey(query), found);
          this.queryCache.set(advisoryKey(query), found, settings.cacheTtlMs);
        }
      } catch (error) {
        const failure = normalizeError(error);
        if (failure.code === "cancelled") {
          throw failure;
        }
        for (const query of chunk) {
          out.set(advisoryKey(query), err(failure));
        }
      }
    }

    const allIds = [...new Set([...idsByKey.values()].flat())];
    const records = new Map<string, Result<Advisory, ManifestLensError>>();
    await mapLimit(
      allIds,
      settings.concurrency,
      async (id) => {
        records.set(id, await this.record(id, settings, signal));
      },
      signal
    );

    for (const [key, ids] of idsByKey) {
      const advisories: Advisory[] = [];
      let failure: ManifestLensError | undefined;
      for (const id of ids) {
        const record = records.get(id);
        if (record?.ok === true) {
          advisories.push(record.value);
        } else if (record?.ok === false) {
          failure = record.error;
        }
      }
      out.set(key, failure ? err(failure) : ok(advisories));
    }
    return out;
  }

  private async queryChunk(
    chunk: readonly AdvisoryQuery[],
    settings: OsvSettings,
    signal: AbortSignal | undefined
  ): Promise<string[][]> {
    const base = validateServiceUrl(settings.baseUrl);
    const url = joinUrl(base, "v1/querybatch");
    const body = {
      queries: chunk.map((query) => ({
        package: { ecosystem: "npm", name: query.name },
        version: query.version,
      })),
    };
    const parsed = batchSchema.safeParse(
      await this.http.json({ body, method: "POST", signal, url })
    );
    if (!parsed.success || parsed.data.results.length !== chunk.length) {
      throw new ManifestLensError(
        "invalid-response",
        "Unexpected OSV batch response."
      );
    }
    const ids: string[][] = [];
    for (const [index, result] of parsed.data.results.entries()) {
      const query = chunk[index];
      const collected = new Set((result.vulns ?? []).map((vuln) => vuln.id));
      if (query && result.next_page_token !== undefined) {
        for (const id of await this.remainingPages(
          query,
          result.next_page_token,
          url,
          signal
        )) {
          collected.add(id);
        }
      }
      ids.push([...collected]);
    }
    return ids;
  }

  private async remainingPages(
    query: AdvisoryQuery,
    firstToken: string,
    url: string,
    signal: AbortSignal | undefined
  ): Promise<string[]> {
    const found: string[] = [];
    let token: string | undefined = firstToken;
    for (let page = 0; token !== undefined && page < MAX_PAGES; page += 1) {
      const next = batchSchema.safeParse(
        await this.http.json({
          body: {
            queries: [
              {
                package: { ecosystem: "npm", name: query.name },
                page_token: token,
                version: query.version,
              },
            ],
          },
          method: "POST",
          signal,
          url,
        })
      );
      const first = next.success ? next.data.results[0] : undefined;
      found.push(...(first?.vulns ?? []).map((vuln) => vuln.id));
      token = first?.next_page_token;
    }
    return found;
  }

  private async record(
    id: string,
    settings: OsvSettings,
    signal: AbortSignal | undefined
  ): Promise<Result<Advisory, ManifestLensError>> {
    try {
      const base = validateServiceUrl(settings.baseUrl);
      const advisory = await this.recordCache.load(
        id,
        async (loadSignal) =>
          parseVulnerability(
            await this.http.json({
              signal: loadSignal,
              url: joinUrl(base, `v1/vulns/${encodeURIComponent(id)}`),
            })
          ),
        { negativeTtlMs: NEGATIVE_TTL_MS, signal, ttlMs: settings.cacheTtlMs }
      );
      return ok(advisory);
    } catch (error) {
      const failure = normalizeError(error);
      if (failure.code === "cancelled") {
        throw failure;
      }
      return err(failure);
    }
  }
}
