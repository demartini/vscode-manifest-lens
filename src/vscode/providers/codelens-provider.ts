import * as vscode from "vscode";

import type { ManifestLensConfig } from "../../config/configuration-schema";
import {
  type LensContext,
  lensesFor,
  sectionLens,
} from "../../presentation/lenses";
import type { AnalysisService } from "../services/analysis-service";
import type { DocumentViews } from "../services/document-view";
import { isManifestDocument } from "../services/uri";
import type { UiState } from "./ui-state";

/** Actionable lenses on dependency lines plus a summary lens per section. */
export class DependencyCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private readonly deps: {
      views: DocumentViews;
      analysis: AnalysisService;
      ui: UiState;
      config: () => ManifestLensConfig;
    }
  ) {
    this.disposables.push(
      this.emitter,
      deps.analysis.onDidChange(() => {
        this.emitter.fire();
      }),
      deps.ui.onDidChange(() => {
        this.emitter.fire();
      })
    );
  }

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const config = this.deps.config();
    if (
      !(
        config.codeLens.enabled &&
        this.deps.ui.suggestionsVisible &&
        isManifestDocument(document)
      )
    ) {
      return [];
    }
    const view = this.deps.views.view(document);
    if (!view) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const uri = document.uri.toString();
    const context: LensContext = {
      prereleaseEnabled: config.prerelease.enabled,
      showUpToDate: config.codeLens.showUpToDate,
    };
    const at = (offset: number): vscode.Position => document.positionAt(offset);

    const head = new vscode.Range(0, 0, 0, 0);
    if (view.state?.status === "loading" && !view.state.analysis) {
      lenses.push(
        new vscode.CodeLens(head, {
          command: "",
          title: "$(sync~spin) Manifest Lens: analyzing dependencies…",
        })
      );
    } else if (view.state?.status === "error" && !view.state.analysis) {
      lenses.push(
        new vscode.CodeLens(head, {
          arguments: [uri],
          command: "manifestLens.refresh",
          title: "$(warning) Manifest Lens: analysis failed — Retry",
          tooltip: view.state.error?.message,
        })
      );
    }

    const items = view.items.map((item) => item.analysis);
    for (const section of view.parsed.sections) {
      const lens = sectionLens(uri, section, items, context);
      if (lens) {
        const range = new vscode.Range(
          at(section.keySpan.start),
          at(section.keySpan.end)
        );
        lenses.push(new vscode.CodeLens(range, this.toCommand(lens)));
      }
    }
    for (const { analysis, declaration } of view.items) {
      const range = new vscode.Range(
        at(declaration.nameSpan.start),
        at(declaration.nameSpan.end)
      );
      for (const lens of lensesFor(analysis, context)) {
        lenses.push(new vscode.CodeLens(range, this.toCommand(lens)));
      }
    }
    return lenses;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private toCommand(lens: {
    title: string;
    tooltip?: string;
    command: string;
    args: readonly string[];
  }): vscode.Command {
    return {
      arguments: [...lens.args],
      command: lens.command,
      title: lens.title,
      ...(lens.tooltip === undefined ? {} : { tooltip: lens.tooltip }),
    };
  }
}
