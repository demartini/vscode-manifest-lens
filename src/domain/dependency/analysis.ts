import type { ManifestLensError } from "../../shared/errors";
import type { DependencyDeclaration } from "../manifest/types";
import type { PeerAnalysis } from "../peer-conflict/types";
import type { Candidate, VersionSelection } from "../version/candidates";
import type { ParsedSpecifier } from "../version/specifier";
import type { MatchedAdvisory } from "../vulnerability/advisory";
import type { ReleaseDetails } from "./metadata";

export type UnsupportedReason =
  | "catalog-unresolved"
  | "invalid"
  | "local"
  | "remote"
  | "tag"
  | "workspace";

export type SupportState =
  | { readonly kind: "supported" }
  | {
      readonly kind: "unsupported";
      readonly reason: UnsupportedReason;
      readonly detail: string;
    };

export type RegistryState =
  | { readonly kind: "ok"; readonly fetchedAt: number }
  | { readonly kind: "error"; readonly error: ManifestLensError }
  | { readonly kind: "skipped" };

/** Security knowledge about one concrete version. */
export type VersionSecurity =
  | { readonly state: "disabled" }
  | { readonly state: "unknown"; readonly reason: string }
  | {
      readonly state: "checked";
      readonly advisories: readonly MatchedAdvisory[];
    };

export type DependencyStatus =
  | "blocked"
  | "error"
  | "unsupported"
  | "up-to-date"
  | "update";

/** Where a catalog reference resolves to. */
export interface CatalogSource {
  readonly manifestUri: string;
  readonly declaration: DependencyDeclaration;
}

export interface PackageLinks {
  readonly npm: string;
  /** The versions tab on npmjs.com. */
  readonly versions: string;
  /** The repository's releases page, when its host layout is known. */
  readonly releases?: string;
  readonly homepage?: string;
  readonly repository?: string;
}

export interface DependencyAnalysis {
  /** `${manifestUri}#${declaration.id}` — unique across the workspace. */
  readonly key: string;
  readonly manifestUri: string;
  readonly declaration: DependencyDeclaration;
  /** The specifier that governs resolution (the catalog entry for catalog refs). */
  readonly specifier: ParsedSpecifier;
  readonly support: SupportState;
  /** Whether a new version can be written back without breaking the syntax. */
  readonly rewritable: boolean;
  /** Where edits must be applied when the declaration points to a catalog. */
  readonly catalogSource?: CatalogSource;
  readonly registryName: string;
  readonly registry: RegistryState;
  readonly installedVersion?: string;
  /** What a fresh install of the current specifier would resolve to. */
  readonly resolvedVersion?: string;
  readonly latestVersion?: string;
  readonly selection?: VersionSelection;
  /** The version security data refers to, with how it was established. */
  readonly currentVersion?: string;
  readonly currentVersionBasis?: "declared-minimum" | "installed";
  readonly deprecation?: { readonly version: string; readonly message: string };
  /** Security results keyed by version (current version and update candidates). */
  readonly security: Readonly<Record<string, VersionSecurity>>;
  /** License and Node engine of the current version and of each update candidate. */
  readonly releaseDetails: Readonly<Record<string, ReleaseDetails>>;
  /** Peer analysis keyed by candidate version. */
  readonly peer: Readonly<Record<string, PeerAnalysis>>;
  /** Newest candidate not blocked by a confirmed peer conflict, when the target is. */
  readonly compatibleCandidate?: Candidate;
  readonly description?: string;
  readonly links: PackageLinks;
  readonly status: DependencyStatus;
}

export interface AnalysisSummary {
  readonly total: number;
  /** Dependencies with an update that is not blocked. */
  readonly updates: number;
  /** Dependencies whose target update has a confirmed peer conflict. */
  readonly blocked: number;
  /** Dependencies whose current version has at least one advisory. */
  readonly vulnerable: number;
  /** Distinct advisories across the manifest (aliases merged). */
  readonly advisories: number;
  readonly errors: number;
  readonly unsupported: number;
}

export interface ManifestAnalysis {
  readonly manifestUri: string;
  readonly documentVersion: number;
  readonly analyzedAt: number;
  readonly items: readonly DependencyAnalysis[];
  readonly summary: AnalysisSummary;
  /** Problems that apply to the manifest as a whole (parse errors, partial data). */
  readonly issues: readonly string[];
  readonly partial: boolean;
}

export const currentSecurity = (
  analysis: DependencyAnalysis
): VersionSecurity | undefined =>
  analysis.currentVersion === undefined
    ? undefined
    : analysis.security[analysis.currentVersion];

export const currentAdvisories = (
  analysis: DependencyAnalysis
): readonly MatchedAdvisory[] => {
  const security = currentSecurity(analysis);
  return security?.state === "checked" ? security.advisories : [];
};

/** Advisories that affect `version` but not the current version. */
export const introducedAdvisories = (
  analysis: DependencyAnalysis,
  version: string
): readonly MatchedAdvisory[] => {
  const security = analysis.security[version];
  if (security?.state !== "checked") {
    return [];
  }
  const existing = new Set(
    currentAdvisories(analysis).map((match) => match.advisory.id)
  );
  return security.advisories.filter(
    (match) => !existing.has(match.advisory.id)
  );
};

export const targetOf = (analysis: DependencyAnalysis): Candidate | undefined =>
  analysis.selection?.target;

export const peerOf = (
  analysis: DependencyAnalysis,
  version: string
): PeerAnalysis | undefined => analysis.peer[version];

export function deriveStatus(
  input: Pick<DependencyAnalysis, "peer" | "registry" | "selection" | "support">
): DependencyStatus {
  if (input.support.kind === "unsupported") {
    return "unsupported";
  }
  if (input.registry.kind !== "ok") {
    return input.registry.kind === "error" ? "error" : "unsupported";
  }
  const target = input.selection?.target;
  if (!target) {
    return "up-to-date";
  }
  return input.peer[target.version]?.status === "blocked"
    ? "blocked"
    : "update";
}

export function summarize(
  items: readonly DependencyAnalysis[]
): AnalysisSummary {
  const advisoryIds = new Set<string>();
  let updates = 0;
  let blocked = 0;
  let vulnerable = 0;
  let errors = 0;
  let unsupported = 0;
  for (const item of items) {
    if (item.status === "update") {
      updates += 1;
    } else if (item.status === "blocked") {
      blocked += 1;
    } else if (item.status === "error") {
      errors += 1;
    } else if (item.status === "unsupported") {
      unsupported += 1;
    }
    const advisories = currentAdvisories(item);
    if (advisories.length > 0) {
      vulnerable += 1;
      for (const match of advisories) {
        advisoryIds.add(match.advisory.id);
      }
    }
  }
  return {
    advisories: advisoryIds.size,
    blocked,
    errors,
    total: items.length,
    unsupported,
    updates,
    vulnerable,
  };
}
