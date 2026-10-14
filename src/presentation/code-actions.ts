import type { DependencyAnalysis } from "../domain/dependency/analysis";
import { type LensContext, lensesFor } from "./lenses";

export interface CodeActionModel {
  readonly title: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Safe to apply without a second look: it never installs or overrides a conflict. */
  readonly preferred: boolean;
}

/**
 * The quick fixes for one dependency. They are the update CodeLens entries, so the
 * lightbulb and the lenses can never disagree about what is offered.
 */
export function codeActionsFor(
  analysis: DependencyAnalysis,
  context: LensContext
): CodeActionModel[] {
  const name = analysis.registryName;
  const actions: CodeActionModel[] = [];
  for (const lens of lensesFor(analysis, context)) {
    const version = lens.args[1] ?? "";
    const base = { args: lens.args, command: lens.command };
    switch (lens.kind) {
      case "update": {
        actions.push({
          ...base,
          preferred: true,
          title: `Update ${name} to ${version}`,
        });
        break;
      }
      case "install": {
        actions.push({
          ...base,
          preferred: false,
          title: `Update ${name} to ${version} and install`,
        });
        break;
      }
      case "compatible": {
        actions.push({
          ...base,
          preferred: false,
          title: `Update ${name} to ${version} (compatible)`,
        });
        break;
      }
      case "blocked-install": {
        actions.push({
          ...base,
          preferred: false,
          title: `Update ${name} to ${version} (blocked, review the conflicts first)`,
        });
        break;
      }
      case "prerelease": {
        actions.push({
          ...base,
          preferred: false,
          title: `Update ${name} to prerelease ${version}`,
        });
        break;
      }
      default: {
        break;
      }
    }
  }
  return actions;
}
