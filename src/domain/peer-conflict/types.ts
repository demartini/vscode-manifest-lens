export type PeerStatus =
  | "blocked"
  | "compatible"
  | "disabled"
  | "potential-conflict"
  | "unknown";

export type ConflictDirection =
  | "blocker-restricts-candidate"
  | "candidate-requires-peer";

export type Confidence = "confirmed" | "potential";

export type Evidence = "declared" | "installed" | "registry";

export interface PeerResolution {
  /** The package whose upgrade would resolve the conflict. */
  readonly package: string;
  readonly version: string;
}

export interface PeerConflict {
  readonly direction: ConflictDirection;
  readonly confidence: Confidence;
  /** The package proposing the upgrade. */
  readonly subject: string;
  readonly candidateVersion: string;
  /** The package imposing (or violating) the peer requirement. */
  readonly blocker: string;
  readonly blockerVersion?: string;
  readonly requiredRange: string;
  readonly optional: boolean;
  readonly evidence: Evidence;
  /** A newer release of the blocker that removes the restriction, if one exists. */
  readonly resolution?: PeerResolution;
  readonly note: string;
}

export interface PeerAnalysis {
  readonly status: PeerStatus;
  readonly conflicts: readonly PeerConflict[];
  /** Upgrades that together would clear every confirmed conflict. */
  readonly coordinatedUpgrade: readonly PeerResolution[];
}

/** What is known about one package that may place peer requirements on others. */
export interface PeerPackageInfo {
  readonly name: string;
  readonly version: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalPeers: readonly string[];
  readonly source: Evidence;
}

export interface PeerRelease {
  readonly version: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
}
