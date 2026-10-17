import type { AnalysisSummary } from "../domain/dependency/analysis";

export type StatusTone = "error" | "loading" | "normal" | "warning";

export interface StatusModel {
  readonly text: string;
  readonly tone: StatusTone;
  readonly tooltip: string;
}

/**
 * Counting rules (also documented in docs/architecture.md):
 * - `↑`  dependencies with an update that is not blocked;
 * - `✋` dependencies whose newest update has a confirmed peer conflict;
 * - `⚠`  dependencies whose current version has at least one advisory
 *        (a dependency counts once however many advisories it has);
 * - `✗`  dependencies whose declared version no published release satisfies.
 */
export function statusFor(
  label: string,
  state:
    | { kind: "error"; message: string }
    | { kind: "loading" }
    | { kind: "ready"; summary: AnalysisSummary; partial: boolean }
): StatusModel {
  if (state.kind === "loading") {
    return {
      text: `$(sync~spin) ${label} checking…`,
      tone: "loading",
      tooltip: "Manifest Lens is analyzing dependencies.",
    };
  }
  if (state.kind === "error") {
    return {
      text: `$(error) ${label} unavailable`,
      tone: "error",
      tooltip: `${state.message}\nClick to retry.`,
    };
  }
  const { summary } = state;
  const parts: string[] = [];
  if (summary.updates > 0) {
    parts.push(`${summary.updates}↑`);
  }
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked}✋`);
  }
  if (summary.vulnerable > 0) {
    parts.push(`${summary.vulnerable}⚠`);
  }
  if (summary.unpublished > 0) {
    parts.push(`${summary.unpublished}✗`);
  }
  if (summary.errors > 0) {
    parts.push(`${summary.errors}?`);
  }
  const detail = parts.length > 0 ? parts.join(" ") : "✓";
  const tooltip = [
    `${summary.updates} updates · ${summary.blocked} blocked · ${summary.vulnerable} vulnerable (${summary.advisories} distinct advisories)`,
    summary.unpublished > 0
      ? `${summary.unpublished} declared ${summary.unpublished === 1 ? "version is" : "versions are"} not published`
      : undefined,
    summary.errors > 0 ? `${summary.errors} could not be checked` : undefined,
    state.partial
      ? "Some data was unavailable; results may be incomplete."
      : undefined,
    "Click to re-run the analysis.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return {
    text: `$(package) ${label} ${detail}`,
    tone:
      summary.blocked > 0 ||
      summary.vulnerable > 0 ||
      summary.unpublished > 0 ||
      summary.errors > 0 ||
      state.partial
        ? "warning"
        : "normal",
    tooltip,
  };
}
