import * as vscode from "vscode";

import type { ManifestLensConfig } from "../../config/configuration-schema";
import {
  currentAdvisories,
  type DependencyAnalysis,
} from "../../domain/dependency/analysis";
import type { AdvisorySeverity } from "../../domain/vulnerability/advisory";
import { compareSeverity } from "../../domain/vulnerability/advisory";
import { clip } from "../../presentation/markdown";
import { createPositionMapper } from "../../shared/utilities/text";
import type {
  AnalysisService,
  ManifestState,
} from "../services/analysis-service";
import type { DocumentViews } from "../services/document-view";

/**
 * Confirmed advisories are shown as errors (red squiggles); only low-severity
 * advisories are downgraded to warnings.
 */
const SEVERITY: Readonly<Record<AdvisorySeverity, vscode.DiagnosticSeverity>> =
  {
    critical: vscode.DiagnosticSeverity.Error,
    high: vscode.DiagnosticSeverity.Error,
    low: vscode.DiagnosticSeverity.Warning,
    moderate: vscode.DiagnosticSeverity.Error,
    unknown: vscode.DiagnosticSeverity.Error,
  };

/** Publishes advisories and deprecations to the Problems panel. */
export class DiagnosticsController implements vscode.Disposable {
  private readonly collection =
    vscode.languages.createDiagnosticCollection("Manifest Lens");
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly deps: {
      analysis: AnalysisService;
      views: DocumentViews;
      config: () => ManifestLensConfig;
    }
  ) {
    this.disposables.push(
      this.collection,
      deps.analysis.onDidChange(({ uri }) => {
        this.update(uri);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (!deps.analysis.get(document.uri.toString())) {
          this.collection.delete(document.uri);
        }
      })
    );
  }

  refreshAll(): void {
    for (const state of this.deps.analysis.states()) {
      this.update(state.uri);
    }
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private update(uri: string): void {
    const state = this.deps.analysis.get(uri);
    const target = vscode.Uri.parse(uri);
    if (!state?.analysis) {
      if (!state) {
        this.collection.delete(target);
      }
      return;
    }
    this.collection.set(target, this.build(state));
  }

  private build(state: ManifestState): vscode.Diagnostic[] {
    const { analysis } = state;
    if (!analysis) {
      return [];
    }
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === state.uri
    );
    const view = open ? this.deps.views.view(open) : undefined;
    const spans = new Map(
      view?.items.map((item) => [item.analysis.key, item.declaration])
    );
    const mapper =
      state.text === undefined ? undefined : createPositionMapper(state.text);
    const diagnostics: vscode.Diagnostic[] = [];
    for (const item of analysis.items) {
      const declaration = open ? spans.get(item.key) : item.declaration;
      if (!declaration) {
        continue;
      }
      const toPosition = (offset: number): vscode.Position => {
        if (open) {
          return open.positionAt(offset);
        }
        const position = mapper?.(offset) ?? { character: 0, line: 0 };
        return new vscode.Position(position.line, position.character);
      };
      const range = new vscode.Range(
        toPosition(declaration.nameSpan.start),
        toPosition(declaration.valueSpan.end)
      );
      diagnostics.push(
        ...this.advisoryDiagnostics(item, range),
        ...this.deprecationDiagnostics(item, range)
      );
    }
    return diagnostics;
  }

  private advisoryDiagnostics(
    item: DependencyAnalysis,
    range: vscode.Range
  ): vscode.Diagnostic[] {
    if (!this.deps.config().security.enabled) {
      return [];
    }
    const scope = item.declaration.direct
      ? "direct dependency"
      : "override of a transitive dependency";
    const basis =
      item.currentVersionBasis === "declared-minimum"
        ? ` (declared minimum; not installed)`
        : "";
    return currentAdvisories(item)
      .toSorted((a, b) =>
        compareSeverity(a.advisory.severity, b.advisory.severity)
      )
      .map((match) => {
        const { advisory } = match;
        const fix =
          match.fixedVersions[0] === undefined
            ? "No fixed version is known."
            : `Fixed in ${match.fixedVersions[0]}.`;
        const diagnostic = new vscode.Diagnostic(
          range,
          `${item.registryName}@${item.currentVersion ?? "?"}${basis} (${scope}) is affected by ${advisory.id} (${advisory.severity}): ${clip(advisory.summary, 160)}. ${fix}`,
          SEVERITY[advisory.severity]
        );
        diagnostic.source = "Manifest Lens";
        const [reference] = advisory.references;
        diagnostic.code = reference
          ? { target: vscode.Uri.parse(reference.url), value: advisory.id }
          : advisory.id;
        return diagnostic;
      });
  }

  private deprecationDiagnostics(
    item: DependencyAnalysis,
    range: vscode.Range
  ): vscode.Diagnostic[] {
    if (!item.deprecation) {
      return [];
    }
    const diagnostic = new vscode.Diagnostic(
      range,
      `${item.registryName}@${item.deprecation.version} is deprecated: ${clip(item.deprecation.message, 200)}`,
      vscode.DiagnosticSeverity.Information
    );
    diagnostic.source = "Manifest Lens";
    diagnostic.tags = [vscode.DiagnosticTag.Deprecated];
    return [diagnostic];
  }
}
