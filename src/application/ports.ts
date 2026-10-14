import type {
  InstalledPackage,
  PackageMetadata,
} from "../domain/dependency/metadata";
import type { ManifestEdit } from "../domain/manifest/types";
import type { Advisory } from "../domain/vulnerability/advisory";
import type { ManifestLensError } from "../shared/errors";
import type { Result } from "../shared/result";

export interface RegistryPort {
  getPackage(
    name: string,
    signal?: AbortSignal
  ): Promise<Result<PackageMetadata, ManifestLensError>>;
}

export interface AdvisoryQuery {
  readonly name: string;
  readonly version: string;
}

export const advisoryKey = (query: AdvisoryQuery): string =>
  `${query.name}@${query.version}`;

export interface AdvisoryPort {
  /** Looks up advisories for each query; results are keyed by {@link advisoryKey}. */
  query(
    queries: readonly AdvisoryQuery[],
    signal?: AbortSignal
  ): Promise<Map<string, Result<readonly Advisory[], ManifestLensError>>>;
}

export interface InstalledPackagesPort {
  /** Resolves `name` the way Node would from `fromDir`, walking up `node_modules`. */
  lookup(fromDir: string, name: string): Promise<InstalledPackage | undefined>;
}

export interface DownloadsPort {
  monthly(name: string, signal?: AbortSignal): Promise<number | undefined>;
}

export interface Clock {
  now(): number;
}

export interface ManifestDocument {
  readonly uri: string;
  readonly text: string;
  /** Increases with every edit; used to detect concurrent changes. */
  readonly version: number;
  readonly isDirty: boolean;
}

export interface ManifestEditorPort {
  read(uri: string): Promise<ManifestDocument>;
  /**
   * Applies span edits to the document and saves it. Fails with a `stale` error
   * if the document version differs from `expectedVersion`.
   */
  apply(
    uri: string,
    edits: readonly ManifestEdit[],
    expectedVersion: number
  ): Promise<Result<void, ManifestLensError>>;
  /** The local filesystem path for a manifest URI, if it has one. */
  fsPath(uri: string): string | undefined;
}
