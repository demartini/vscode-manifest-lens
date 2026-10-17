import {
  type DependencyAnalysis,
  currentAdvisories,
} from "../domain/dependency/analysis";
import type { SectionInfo } from "../domain/manifest/types";
import { planBulkUpdate } from "../domain/update-plan/plan";
import { rewriteSpecifier } from "../domain/version/specifier";
import { blockersOf } from "./annotation";

export type LensKind =
  | "advisories"
  | "blocked-info"
  | "blocked-install"
  | "compatible"
  | "install"
  | "prerelease"
  | "resolved"
  | "retry"
  | "up-to-date"
  | "update";

export interface LensModel {
  readonly kind: LensKind;
  readonly title: string;
  readonly tooltip?: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface LensContext {
  readonly showUpToDate: boolean;
  readonly prereleaseEnabled: boolean;
}

export const COMMANDS = {
  openPackagePage: "manifestLens.openPackagePage",
  refresh: "manifestLens.refresh",
  resolveToInstalled: "manifestLens.resolveToInstalled",
  showAdvisories: "manifestLens.showAdvisories",
  showConflicts: "manifestLens.showConflicts",
  updateBlocked: "manifestLens.updateBlockedDependency",
  updateDependency: "manifestLens.updateDependency",
  updateDependencyAndInstall: "manifestLens.updateDependencyAndInstall",
  updateSection: "manifestLens.updateSection",
} as const;

const dependencyCount = (count: number): string =>
  count === 1 ? "1 dependency" : `${count} dependencies`;

/** The CodeLens entries for a single dependency, in display order. */
export function lensesFor(
  analysis: DependencyAnalysis,
  context: LensContext
): LensModel[] {
  if (analysis.status === "unsupported") {
    return [];
  }
  if (analysis.status === "error") {
    return [
      {
        args: [analysis.manifestUri],
        command: COMMANDS.refresh,
        kind: "retry",
        title: "$(warning) Registry unavailable — Retry",
      },
    ];
  }
  const lenses: LensModel[] = [];
  const installed = analysis.installedVersion;
  if (
    installed !== undefined &&
    rewriteSpecifier(analysis.specifier, installed, {
      section: analysis.declaration.section,
    }) !== undefined
  ) {
    lenses.push({
      args: [analysis.key],
      command: COMMANDS.resolveToInstalled,
      kind: "resolved",
      title: `Resolved as ${installed}`,
      tooltip: `Rewrite the specifier to the installed version (${installed}) without installing anything.`,
    });
  }
  const target = analysis.selection?.target;
  if (target) {
    const blockers = blockersOf(analysis, target.version);
    if (analysis.peer[target.version]?.status === "blocked") {
      lenses.push(
        {
          args: [analysis.key, target.version],
          command: COMMANDS.showConflicts,
          kind: "blocked-info",
          title: `${target.version} blocked by ${dependencyCount(blockers.length)}`,
          tooltip: "Show the peer dependency conflicts.",
        },
        {
          args: [analysis.key, target.version],
          command: COMMANDS.updateBlocked,
          kind: "blocked-install",
          title: "Install Blocked Update",
          tooltip:
            "Review the conflicts, then update and install after explicit confirmation.",
        }
      );
      const compatible = analysis.compatibleCandidate;
      if (compatible) {
        lenses.push({
          args: [analysis.key, compatible.version],
          command: COMMANDS.updateDependency,
          kind: "compatible",
          title: `Update to ${compatible.version} (compatible)`,
        });
      }
    } else {
      lenses.push(
        {
          args: [analysis.key, target.version],
          command: COMMANDS.updateDependency,
          kind: "update",
          title: `Update to ${target.version}`,
          tooltip:
            "Rewrite the specifier and save the manifest. Nothing is installed.",
        },
        {
          args: [analysis.key, target.version],
          command: COMMANDS.updateDependencyAndInstall,
          kind: "install",
          title: "Install Update",
          tooltip:
            "Rewrite the specifier, save the manifest and run the package manager's install.",
        }
      );
    }
  }
  const pre = analysis.selection?.prerelease;
  if (context.prereleaseEnabled && pre) {
    lenses.push({
      args: [analysis.key, pre.version],
      command: COMMANDS.updateDependency,
      kind: "prerelease",
      title: `Prerelease ${pre.version}`,
    });
  }
  const advisories = currentAdvisories(analysis);
  if (advisories.length > 0) {
    lenses.push({
      args: [analysis.key],
      command: COMMANDS.showAdvisories,
      kind: "advisories",
      title: `$(shield) ${advisories.length} ${advisories.length === 1 ? "advisory" : "advisories"}`,
    });
  }
  if (
    !target &&
    lenses.length === 0 &&
    context.showUpToDate &&
    analysis.status !== "unpublished"
  ) {
    lenses.push({
      args: [analysis.links.npm],
      command: COMMANDS.openPackagePage,
      kind: "up-to-date",
      title: "Up to date",
    });
  }
  return lenses;
}

/** The summary lens that sits on a dependency section's key. */
export function sectionLens(
  manifestUri: string,
  section: SectionInfo,
  items: readonly DependencyAnalysis[],
  context: LensContext
): LensModel | undefined {
  const members = items.filter((item) =>
    section.declarationIds.includes(item.declaration.id)
  );
  const plan = planBulkUpdate(members, {
    policy: "conservative",
    scope: "all",
  });
  const blocked = plan.skipped.filter(
    (skipped) => skipped.reason === "blocked"
  ).length;
  if (plan.eligible.length === 0 && blocked === 0) {
    const unpublished = members.some(
      (member) => member.status === "unpublished"
    );
    return context.showUpToDate && members.length > 0 && !unpublished
      ? {
          args: [],
          command: COMMANDS.refresh,
          kind: "up-to-date",
          title: "All up to date",
        }
      : undefined;
  }
  const parts = [
    `${plan.eligible.length} ${plan.eligible.length === 1 ? "update" : "updates"} available`,
  ];
  if (blocked > 0) {
    parts.push(`${blocked} blocked`);
  }
  return {
    args: [manifestUri, section.id],
    command: COMMANDS.updateSection,
    kind: "update",
    title: `${parts.join(" · ")} — Update all`,
    tooltip:
      "Review and update every eligible dependency in this section. Blocked updates are skipped.",
  };
}
