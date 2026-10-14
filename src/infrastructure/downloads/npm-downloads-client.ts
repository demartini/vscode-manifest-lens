import { z } from "zod";

import type { DownloadsPort } from "../../application/ports";
import { isValidPackageName } from "../../domain/manifest/package-name";
import { TtlCache } from "../cache/ttl-cache";
import type { HttpClient } from "../http/http-client";

const responseSchema = z.looseObject({ downloads: z.number().nonnegative() });

const TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60_000;

/** Monthly download counts from the public npm downloads API (default registry only). */
export class NpmDownloadsClient implements DownloadsPort {
  private readonly cache = new TtlCache<number>(1000);

  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl = "https://api.npmjs.org/"
  ) {}

  async monthly(
    name: string,
    signal?: AbortSignal
  ): Promise<number | undefined> {
    if (!isValidPackageName(name)) {
      return undefined;
    }
    try {
      return await this.cache.load(
        name,
        async (loadSignal) => {
          const payload = await this.http.json({
            signal: loadSignal,
            url: `${this.baseUrl}downloads/point/last-month/${name}`,
          });
          return responseSchema.parse(payload).downloads;
        },
        { negativeTtlMs: NEGATIVE_TTL_MS, signal, ttlMs: TTL_MS }
      );
    } catch {
      return undefined;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
