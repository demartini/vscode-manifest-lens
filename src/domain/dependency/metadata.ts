export interface VersionMetadata {
  readonly version: string;
  readonly deprecated?: string;
  readonly publishedAt?: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
  /** Names of peers that `peerDependenciesMeta` marks as optional. */
  readonly optionalPeers: readonly string[];
}

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
