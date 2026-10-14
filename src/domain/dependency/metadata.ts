export interface VersionMetadata {
  readonly version: string;
  readonly deprecated?: string;
  readonly publishedAt?: string;
  /** SPDX expression or free text from the `license` field. */
  readonly license?: string;
  /** The raw `engines.node` range the release declares. */
  readonly nodeEngine?: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
  /** Names of peers that `peerDependenciesMeta` marks as optional. */
  readonly optionalPeers: readonly string[];
}

/** The parts of a release that the hover shows next to its version. */
export type ReleaseDetails = Pick<VersionMetadata, "license" | "nodeEngine">;

/** Registry data for one package, reduced to what the extension needs. */
export interface PackageMetadata {
  readonly name: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly repositoryUrl?: string;
  readonly distTags: Readonly<Record<string, string>>;
  readonly versions: Readonly<Record<string, VersionMetadata>>;
  /** Epoch milliseconds at which the data was retrieved. */
  readonly fetchedAt: number;
}

export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalPeers: readonly string[];
  readonly deprecated?: string;
}
