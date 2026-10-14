import { z } from "zod";

import type { RegistryPort } from "../../application/ports";
import type {
  PackageMetadata,
  VersionMetadata,
} from "../../domain/dependency/metadata";
import { isValidPackageName } from "../../domain/manifest/package-name";
import { ManifestLensError, normalizeError } from "../../shared/errors";
import { type Result, err, ok } from "../../shared/result";
import { TtlCache } from "../cache/ttl-cache";
import type { HttpClient } from "../http/http-client";
import { joinUrl, validateServiceUrl } from "../http/url";

export interface RegistrySettings {
  readonly registryUrl: string;
  readonly cacheTtlMs: number;
}

const NEGATIVE_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

const stringRecord = z.record(z.string(), z.string());

// `engines` and `license` come in several historical shapes; they are read leniently
// so a malformed value never drops the whole version.
const versionSchema = z.looseObject({
  deprecated: z.union([z.string(), z.boolean()]).optional(),
  engines: z.unknown().optional(),
  license: z.unknown().optional(),
  peerDependencies: stringRecord.optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.looseObject({ optional: z.boolean().optional() }))
    .optional(),
});

const packumentSchema = z.looseObject({
  description: z.string().optional(),
  "dist-tags": stringRecord.optional(),
  homepage: z.string().optional(),
  name: z.string(),
  repository: z
    .union([z.string(), z.looseObject({ url: z.string().optional() })])
    .optional(),
  time: z.record(z.string(), z.string()).optional(),
  versions: z.record(z.string(), z.unknown()).default({}),
});

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/** Normalizes the many spellings of repository URLs to a browsable https URL. */
export function normalizeRepositoryUrl(
  raw: string | undefined
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let value = raw.trim().replace(/^git\+/u, "");
  const scp = /^git@([^:]+):(.+)$/u.exec(value);
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    value = `https://${scp[1]}/${scp[2]}`;
  }
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/u.exec(value);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    value = `https://${shorthand[1]}.com/${shorthand[2]}`;
  }
  if (/^[\w.-]+\/[\w.-]+$/u.test(value)) {
    value = `https://github.com/${value}`;
  }
  value = value
    .replace(/^(git|ssh):\/\/(?:git@)?/u, "https://")
    .replace(/\.git(#.*)?$/u, "")
    .replace(/#.*$/u, "");
  return isHttpUrl(value) ? value : undefined;
}

const MAX_TEXT_LENGTH = 200;

const textOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= MAX_TEXT_LENGTH
    ? trimmed
    : undefined;
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

/** `license` is a string, or the legacy `{ type, url }` object. */
const licenseOf = (raw: unknown): string | undefined =>
  textOf(raw) ?? textOf(recordOf(raw)?.type);

const nodeEngineOf = (raw: unknown): string | undefined =>
  textOf(recordOf(raw)?.node);

const toVersion = (
  version: string,
  raw: z.infer<typeof versionSchema>,
  publishedAt: string | undefined
): VersionMetadata => {
  const flag = raw.deprecated;
  let deprecated: string | undefined;
  if (typeof flag === "string" && flag !== "") {
    deprecated = flag;
  } else if (flag === true) {
    deprecated = "This version is deprecated.";
  }
  const optionalPeers = Object.entries(raw.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional === true)
    .map(([name]) => name);
  const license = licenseOf(raw.license);
  const nodeEngine = nodeEngineOf(raw.engines);
  return {
    ...(deprecated === undefined ? {} : { deprecated }),
    ...(license === undefined ? {} : { license }),
    ...(nodeEngine === undefined ? {} : { nodeEngine }),
    optionalPeers,
    peerDependencies: raw.peerDependencies ?? {},
    ...(publishedAt === undefined ? {} : { publishedAt }),
    version,
  };
};

/** Parses and reduces a registry packument. Throws `invalid-response` on bad shapes. */
export function parsePackument(payload: unknown, now: number): PackageMetadata {
  const parsed = packumentSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ManifestLensError(
      "invalid-response",
      "Unexpected registry response shape.",
      {
        cause: parsed.error,
      }
    );
  }
  const { data } = parsed;
  const versions: Record<string, VersionMetadata> = {};
  for (const [version, rawVersion] of Object.entries(data.versions)) {
    const checked = versionSchema.safeParse(rawVersion);
    if (checked.success) {
      versions[version] = toVersion(
        version,
        checked.data,
        data.time?.[version]
      );
    }
  }
  const repositoryRaw =
    typeof data.repository === "string"
      ? data.repository
      : data.repository?.url;
  const homepage =
    data.homepage !== undefined && isHttpUrl(data.homepage)
      ? data.homepage
      : undefined;
  const repositoryUrl = normalizeRepositoryUrl(repositoryRaw);
  return {
    ...(data.description === undefined
      ? {}
      : { description: data.description }),
    distTags: data["dist-tags"] ?? {},
    fetchedAt: now,
    ...(homepage === undefined ? {} : { homepage }),
    name: data.name,
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    versions,
  };
}

/** Registry access for npm-compatible registries, with caching and request de-duplication. */
export class NpmRegistryClient implements RegistryPort {
  private readonly cache: TtlCache<PackageMetadata>;
  private readonly http: HttpClient;
  private readonly settings: () => RegistrySettings;
  private readonly now: () => number;

  constructor(options: {
    http: HttpClient;
    settings: () => RegistrySettings;
    now?: () => number;
  }) {
    this.http = options.http;
    this.settings = options.settings;
    this.now = options.now ?? Date.now;
    this.cache = new TtlCache<PackageMetadata>(MAX_ENTRIES, this.now);
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  invalidate(name: string): void {
    this.cache.deleteWhere((key) => key.endsWith(`|${name}`));
  }

  async getPackage(
    name: string,
    signal?: AbortSignal
  ): Promise<Result<PackageMetadata, ManifestLensError>> {
    if (!isValidPackageName(name)) {
      return err(
        new ManifestLensError(
          "unsupported",
          `"${name}" is not a valid package name.`
        )
      );
    }
    try {
      const { registryUrl, cacheTtlMs } = this.settings();
      const base = validateServiceUrl(registryUrl);
      const url = joinUrl(base, name.replace("/", "%2F"));
      const metadata = await this.cache.load(
        `${base.origin}${base.pathname}|${name}`,
        async (loadSignal) =>
          parsePackument(
            await this.http.json({ signal: loadSignal, url }),
            this.now()
          ),
        { negativeTtlMs: NEGATIVE_TTL_MS, signal, ttlMs: cacheTtlMs }
      );
      return ok(metadata);
    } catch (error) {
      return err(normalizeError(error));
    }
  }
}
