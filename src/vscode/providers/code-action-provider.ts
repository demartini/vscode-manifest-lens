import * as vscode from "vscode";

import type { ManifestLensConfig } from "../../config/configuration-schema";
import { codeActionsFor } from "../../presentation/code-actions";
import type { DocumentViews } from "../services/document-view";
import { isManifestDocument } from "../services/uri";

/** Lightbulb quick fixes that update the dependency under the cursor. */
export class DependencyCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(
    private readonly deps: {
      views: DocumentViews;
      config: () => ManifestLensConfig;
    }
  ) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.CodeAction[] {
    if (!isManifestDocument(document)) {
      return [];
    }
    const view = this.deps.views.view(document);
    // A stale result describes text that has since changed: offer nothing until it refreshes.
    if (!view || view.state?.stale === true) {
      return [];
    }
    const context = {
      prereleaseEnabled: this.deps.config().prerelease.enabled,
      showUpToDate: false,
    };
    const actions: vscode.CodeAction[] = [];
    for (const { analysis, declaration } of view.items) {
      const first = document.positionAt(declaration.nameSpan.start).line;
      const last = document.positionAt(declaration.valueSpan.end).line;
      if (range.start.line > last || range.end.line < first) {
        continue;
      }
      for (const model of codeActionsFor(analysis, context)) {
        const action = new vscode.CodeAction(
          model.title,
          vscode.CodeActionKind.QuickFix
        );
        action.command = {
          arguments: [...model.args],
          command: model.command,
          title: model.title,
        };
        action.isPreferred = model.preferred;
        actions.push(action);
      }
    }
    return actions;
  }
}
