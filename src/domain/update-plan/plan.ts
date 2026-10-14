import {
  type DependencyAnalysis,
  introducedAdvisories,
} from "../dependency/analysis";
import type { PeerConflict } from "../peer-conflict/types";
import type { Candidate } from "../version/candidates";
import { classifyUpdate } from "../version/classification";
import { rewriteSpecifier } from "../version/specifier";

export type UpdateScope = "all" | "major" | "minor" | "patch";
export type UpdatePolicy = "conservative" | "force";

export type PlanRisk =
  | { readonly kind: "breaking" }
  | { readonly kind: "introduces-advisory"; readonly ids: readonly string[] }
  | {
      readonly kind: "peer-blocked";
      readonly conflicts: readonly PeerConflict[];
    }
  | {
      readonly kind: "peer-potential";
      readonly conflicts: readonly PeerConflict[];
    };

export interface PlannedUpdate {
  readonly key: string;
  readonly analysis: DependencyAnalysis;
  readonly candidate: Candidate;
  readonly fromVersion: string;
  readonly newSpecifier: string;
  readonly risks: readonly PlanRisk[];
}

export type SkipReason =
  | "blocked"
  | "error"
  | "no-update"
  | "not-rewritable"
  | "unsupported";

export interface SkippedUpdate {
  readonly key: string;
  readonly name: string;
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface UpdatePlan {
  readonly eligible: readonly PlannedUpdate[];
  readonly skipped: readonly SkippedUpdate[];
  /** True when proceeding needs an explicit user decision. */
  readonly requiresConfirmation: boolean;
}

export const candidateForScope = (
  analysis: DependencyAnalysis,
  scope: UpdateScope
): Candidate | undefined => {
  const { selection } = analysis;
  if (!selection) {
    return undefined;
  }
  return scope === "all" ? selection.target : selection[scope];
};

const risksFor = (
  analysis: DependencyAnalysis,
  candidate: Candidate
): PlanRisk[] => {
  const risks: PlanRisk[] = [];
  const peer = analysis.peer[candidate.version];
  if (peer?.status === "blocked") {
    risks.push({
      conflicts: peer.conflicts.filter(
        (conflict) => conflict.confidence === "confirmed"
      ),
      kind: "peer-blocked",
    });
  } else if (peer?.status === "potential-conflict") {
    risks.push({ conflicts: peer.conflicts, kind: "peer-potential" });
  }
  const introduced = introducedAdvisories(analysis, candidate.version);
  if (introduced.length > 0) {
    risks.push({
      ids: introduced.map((match) => match.advisory.id),
      kind: "introduces-advisory",
    });
  }
  if (candidate.potentiallyBreaking) {
    risks.push({ kind: "breaking" });
  }
  return risks;
};

const skip = (
  analysis: DependencyAnalysis,
  reason: SkipReason,
  detail: string
): SkippedUpdate => ({
  detail,
  key: analysis.key,
  name: analysis.declaration.name,
  reason,
});

/** Plans the update of one dependency to a specific candidate. */
export function planSingleUpdate(
  analysis: DependencyAnalysis,
  candidate: Candidate,
  policy: UpdatePolicy
): { update?: PlannedUpdate; skipped?: SkippedUpdate } {
  if (analysis.support.kind === "unsupported") {
    return { skipped: skip(analysis, "unsupported", analysis.support.detail) };
  }
  if (analysis.registry.kind === "error") {
    return {
      skipped: skip(analysis, "error", analysis.registry.error.message),
    };
  }
  const newSpecifier = rewriteSpecifier(analysis.specifier, candidate.version, {
    section: analysis.declaration.section,
  });
  if (!analysis.rewritable || newSpecifier === undefined) {
    return {
      skipped: skip(
        analysis,
        "not-rewritable",
        `"${analysis.declaration.specifier}" cannot be rewritten automatically.`
      ),
    };
  }
  const risks = risksFor(analysis, candidate);
  const blocked = risks.find((risk) => risk.kind === "peer-blocked");
  if (blocked && policy === "conservative") {
    const names = blocked.conflicts
      .map((conflict) => conflict.blocker)
      .join(", ");
    return {
      skipped: skip(
        analysis,
        "blocked",
        `${candidate.version} is blocked by ${names}.`
      ),
    };
  }
  return {
    update: {
      analysis,
      candidate,
      fromVersion:
        analysis.selection?.baseVersion ?? analysis.declaration.specifier,
      key: analysis.key,
      newSpecifier,
      risks,
    },
  };
}

/** Plans a bulk update across many dependencies from one analysis snapshot. */
export function planBulkUpdate(
  items: readonly DependencyAnalysis[],
  options: { scope: UpdateScope; policy: UpdatePolicy }
): UpdatePlan {
  const eligible: PlannedUpdate[] = [];
  const skipped: SkippedUpdate[] = [];
  for (const analysis of items) {
    const candidate = candidateForScope(analysis, options.scope);
    if (!candidate) {
      if (analysis.support.kind === "unsupported") {
        skipped.push(skip(analysis, "unsupported", analysis.support.detail));
      } else if (analysis.registry.kind === "error") {
        skipped.push(skip(analysis, "error", analysis.registry.error.message));
      }
      continue;
    }
    const { update, skipped: skippedItem } = planSingleUpdate(
      analysis,
      candidate,
      options.policy
    );
    if (update) {
      eligible.push(update);
    }
    if (skippedItem) {
      skipped.push(skippedItem);
    }
  }
  const requiresConfirmation = eligible.some((update) =>
    update.risks.some((risk) => risk.kind !== "breaking")
  );
  return { eligible, requiresConfirmation, skipped };
}

/** Plans rewriting the specifier to the version that is actually installed. */
export function planResolveToInstalled(analysis: DependencyAnalysis): {
  update?: PlannedUpdate;
  skipped?: SkippedUpdate;
} {
  const installed = analysis.installedVersion;
  if (installed === undefined) {
    return {
      skipped: skip(analysis, "no-update", "No installed version was found."),
    };
  }
  const newSpecifier = rewriteSpecifier(analysis.specifier, installed, {
    section: analysis.declaration.section,
  });
  if (!analysis.rewritable || newSpecifier === undefined) {
    return {
      skipped: skip(
        analysis,
        "not-rewritable",
        `"${analysis.declaration.specifier}" already matches ${installed} or cannot be rewritten.`
      ),
    };
  }
  const base = analysis.selection?.baseVersion ?? installed;
  return {
    update: {
      analysis,
      candidate: {
        potentiallyBreaking: false,
        severity: classifyUpdate(base, installed),
        version: installed,
      },
      fromVersion: base,
      key: analysis.key,
      newSpecifier,
      risks: [],
    },
  };
}
