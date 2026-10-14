import type {
  AdvisoryPort,
  InstalledPackagesPort,
  RegistryPort,
} from "../../src/application/ports";
import type {
  InstalledPackage,
  PackageMetadata,
  VersionMetadata,
} from "../../src/domain/dependency/metadata";
import type { Advisory } from "../../src/domain/vulnerability/advisory";
import { ManifestLensError } from "../../src/shared/errors";
import { err, ok } from "../../src/shared/result";

export const NOW = Date.parse("2026-01-10T00:00:00Z");

export interface FakeVersion {
  deprecated?: string;
  license?: string;
  nodeEngine?: string;
  peers?: Record<string, string>;
  optionalPeers?: string[];
}

export const pkg = (
  name: string,
  versions: Record<string, FakeVersion | undefined>,
  latest?: string,
  extra: Partial<PackageMetadata> = {}
): PackageMetadata => {
  const entries: Record<string, VersionMetadata> = {};
  for (const [version, info] of Object.entries(versions)) {
    entries[version] = {
      ...(info?.deprecated === undefined
        ? {}
        : { deprecated: info.deprecated }),
      ...(info?.license === undefined ? {} : { license: info.license }),
      ...(info?.nodeEngine === undefined
        ? {}
        : { nodeEngine: info.nodeEngine }),
      optionalPeers: info?.optionalPeers ?? [],
      peerDependencies: info?.peers ?? {},
      publishedAt: "2026-01-06T00:00:00Z",
      version,
    };
  }
  const keys = Object.keys(entries);
  return {
    description: `${name} description`,
    distTags: { latest: latest ?? keys.at(-1) ?? "0.0.0" },
    fetchedAt: NOW,
    name,
    versions: entries,
    ...extra,
  };
};

export class FakeRegistry implements RegistryPort {
  readonly calls: string[] = [];
  private readonly packages = new Map<string, PackageMetadata>();
  private readonly failures = new Set<string>();

  add(metadata: PackageMetadata): this {
    this.packages.set(metadata.name, metadata);
    return this;
  }

  fail(name: string): this {
    this.failures.add(name);
    return this;
  }

  async getPackage(name: string) {
    this.calls.push(name);
    const found = this.packages.get(name);
    if (this.failures.has(name)) {
      return err(new ManifestLensError("network", `offline: ${name}`));
    }
    return found
      ? ok(found)
      : err(new ManifestLensError("not-found", `${name} not found`));
  }
}

export class FakeInstalled implements InstalledPackagesPort {
  private readonly packages = new Map<string, InstalledPackage>();

  add(
    name: string,
    version: string,
    peers: Record<string, string> = {},
    optional: string[] = []
  ): this {
    this.packages.set(name, {
      name,
      optionalPeers: optional,
      peerDependencies: peers,
      version,
    });
    return this;
  }

  async lookup(_dir: string, name: string) {
    return this.packages.get(name);
  }
}

export class FakeAdvisories implements AdvisoryPort {
  readonly queries: string[] = [];
  private readonly advisories = new Map<string, Advisory[]>();
  failAll = false;

  add(name: string, version: string, advisory: Advisory): this {
    const key = `${name}@${version}`;
    this.advisories.set(key, [...(this.advisories.get(key) ?? []), advisory]);
    return this;
  }

  async query(queries: readonly { name: string; version: string }[]) {
    const out = new Map<
      string,
      | ReturnType<typeof ok<readonly Advisory[]>>
      | ReturnType<typeof err<ManifestLensError>>
    >();
    for (const query of queries) {
      const key = `${query.name}@${query.version}`;
      this.queries.push(key);
      out.set(
        key,
        this.failAll
          ? err(new ManifestLensError("network", "osv down"))
          : ok(this.advisories.get(key) ?? [])
      );
    }
    return out;
  }
}

export const makeAdvisory = (
  id: string,
  name: string,
  events: { introduced?: string; fixed?: string }[],
  aliases: string[] = []
): Advisory => ({
  affected: [
    {
      ecosystem: "npm",
      name,
      ranges: [{ events, type: "SEMVER" }],
      versions: [],
    },
  ],
  aliases,
  id,
  references: [{ type: "ADVISORY", url: `https://example.com/${id}` }],
  severity: "high",
  summary: `${id} summary`,
});
