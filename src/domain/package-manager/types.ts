export type PackageManagerName = "bun" | "npm" | "pnpm" | "yarn";

export const PACKAGE_MANAGERS: readonly PackageManagerName[] = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
];

export interface PackageManagerDetection {
  readonly manager: PackageManagerName;
  /** Directory the install command must run in. */
  readonly root: string;
  /** Why this manager was chosen, for diagnostics. */
  readonly evidence: string;
}

/** Flags that may be passed to an install, and only after explicit user approval. */
export type InstallFlag = "--legacy-peer-deps";

export interface InstallResult {
  readonly success: boolean;
  readonly cancelled: boolean;
  readonly exitCode: number | undefined;
}
