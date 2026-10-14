import { readFile, stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

import { z } from "zod";

import type { InstalledPackagesPort } from "../../application/ports";
import type { InstalledPackage } from "../../domain/dependency/metadata";
import { TtlCache } from "../cache/ttl-cache";

const MAX_MANIFEST_BYTES = 1_000_000;
const TTL_MS = 10 * 60 * 1000;

const manifestSchema = z.looseObject({
  deprecated: z.string().optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.looseObject({ optional: z.boolean().optional() }))
    .optional(),
  version: z.string(),
});

const readInstalled = async (
  file: string,
  name: string
): Promise<InstalledPackage | undefined> => {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      return undefined;
    }
    const parsed = manifestSchema.safeParse(
      JSON.parse(await readFile(file, "utf-8"))
    );
    if (!parsed.success) {
      return undefined;
    }
    const { data } = parsed;
    return {
      ...(data.deprecated === undefined || data.deprecated === ""
        ? {}
        : { deprecated: data.deprecated }),
      name,
      optionalPeers: Object.entries(data.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta.optional === true)
        .map(([peer]) => peer),
      peerDependencies: data.peerDependencies ?? {},
      version: data.version,
    };
  } catch {
    return undefined;
  }
};

/** Reads installed package metadata from `node_modules` using Node's resolution walk. */
export class NodeInstalledPackages implements InstalledPackagesPort {
  private readonly cache = new TtlCache<InstalledPackage | undefined>(2000);

  /** Drops cached results, e.g. after a lockfile or `node_modules` change. */
  invalidate(): void {
    this.cache.clear();
  }

  async lookup(
    fromDir: string,
    name: string
  ): Promise<InstalledPackage | undefined> {
    return await this.cache.load(
      `${fromDir}|${name}`,
      async () => {
        let dir = fromDir;
        const { root } = parse(dir);
        for (;;) {
          const file = join(
            dir,
            "node_modules",
            ...name.split("/"),
            "package.json"
          );
          const found = await readInstalled(file, name);
          if (found) {
            return found;
          }
          const parent = dirname(dir);
          if (parent === dir || dir === root) {
            return;
          }
          dir = parent;
        }
      },
      { ttlMs: TTL_MS }
    );
  }
}
