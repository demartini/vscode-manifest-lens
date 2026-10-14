import {
  type DependencyAnalysis,
  currentAdvisories,
  currentSecurity,
  introducedAdvisories,
} from "../domain/dependency/analysis";
import type { UpdateSeverity } from "../domain/version/classification";
import { formatRelativeTime } from "../shared/utilities/time";

export type Tone = "error" | "info" | "muted" | "ok" | "warning";

export interface Annotation {
  readonly text: string;
  readonly tone: Tone;
}

export type MinimumSeverity = "major" | "minor" | "patch";

export interface AnnotationContext {
  readonly now: number;
  readonly minimumSeverity: MinimumSeverity;
  readonly prereleaseEnabled: boolean;
  readonly securityEnabled: boolean;
}

const RANK: Readonly<Record<UpdateSeverity, number>> = {
  major: 3,
  minor: 2,
  patch: 1,
  prerelease: 0,
  unknown: 1,
};
const MIN_RANK: Readonly<Record<MinimumSeverity, number>> = {
  major: 3,
  minor: 2,
  patch: 0,
};

const advisoriesLabel = (count: number): string =>
  count === 1 ? "1 advisory" : `${count} advisories`;

const UNSUPPORTED_LABEL: Readonly<Record<string, string>> = {
  "catalog-unresolved": "unresolved catalog",
  invalid: "unrecognized version",
  local: "local path",
  remote: "git/url",
  tag: "tag",
  workspace: "workspace",
};

/** Blockers of a candidate, distinct and in a stable order. */
export const blockersOf = (
  analysis: DependencyAnalysis,
  version: string
): string[] => {
  const conflicts = analysis.peer[version]?.conflicts ?? [];
  return [
    ...new Set(
      conflicts
        .filter((conflict) => conflict.confidence === "confirmed")
        .map((c) => c.blocker)
    ),
  ];
};

const updatePart = (
  analysis: DependencyAnalysis,
  context: AnnotationContext
): Annotation | undefined => {
  const target = analysis.selection?.target;
  if (!target) {
    return undefined;
  }
  const peer = analysis.peer[target.version];
  if (peer?.status === "blocked") {
    return {
      text: `✋ ${target.version} blocked by ${blockersOf(analysis, target.version).join(", ")}`,
      tone: "warning",
    };
  }
  if (RANK[target.severity] < MIN_RANK[context.minimumSeverity]) {
    return undefined;
  }
  const age = formatRelativeTime(target.publishedAt, context.now);
  let text = `⬆ ${target.version} (${target.severity})${age ? ` — ${age}` : ""}`;
  if (peer?.status === "potential-conflict") {
    text += " · ⚠ possible peer conflict";
  } else if (peer?.status === "unknown") {
    text += " · peers unverified";
  }
  const introduced = introducedAdvisories(analysis, target.version).length;
  if (introduced > 0) {
    text += ` · ⚠ adds ${advisoriesLabel(introduced)}`;
  }
  const tone: Tone =
    target.severity === "major" || introduced > 0 ? "warning" : "info";
  return { text, tone };
};

/** The end-of-line annotation for one dependency, or empty text when nothing should show. */
export function annotationOf(
  analysis: DependencyAnalysis,
  context: AnnotationContext
): Annotation {
  if (analysis.status === "unsupported") {
    const reason =
      analysis.support.kind === "unsupported"
        ? analysis.support.reason
        : "invalid";
    return { text: `◦ ${UNSUPPORTED_LABEL[reason] ?? reason}`, tone: "muted" };
  }
  if (analysis.status === "error") {
    const code =
      analysis.registry.kind === "error"
        ? analysis.registry.error.code
        : "unexpected";
    return { text: `⚠ registry unavailable (${code})`, tone: "warning" };
  }
  const parts: string[] = [];
  let tone: Tone = "ok";
  const raise = (next: Tone): void => {
    const order: Tone[] = ["muted", "ok", "info", "warning", "error"];
    if (order.indexOf(next) > order.indexOf(tone)) {
      tone = next;
    }
  };

  const advisories = currentAdvisories(analysis);
  if (advisories.length > 0) {
    parts.push(`⚠ ${advisoriesLabel(advisories.length)}`);
    raise("error");
  } else if (
    context.securityEnabled &&
    currentSecurity(analysis)?.state === "unknown"
  ) {
    parts.push("? advisories unavailable");
    raise("warning");
  }
  if (analysis.deprecation) {
    parts.push("⊘ deprecated");
    raise("warning");
  }
  const update = updatePart(analysis, context);
  if (update) {
    parts.push(update.text);
    raise(update.tone);
  } else if (analysis.selection?.target === undefined) {
    parts.push("✓ up to date");
  }
  const pre = analysis.selection?.prerelease;
  if (context.prereleaseEnabled && pre) {
    parts.push(`β ${pre.version}`);
  }
  if (parts.length === 0) {
    return { text: "", tone: "muted" };
  }
  return { text: parts.join(" · "), tone };
}
