import * as vscode from "vscode";

import type { ManifestLensConfig } from "../../config/configuration-schema";
import {
  type AnnotationContext,
  type Tone,
  annotationOf,
} from "../../presentation/annotation";
import type { AnalysisService } from "../services/analysis-service";
import type { DocumentViews } from "../services/document-view";
import { isManifestDocument } from "../services/uri";

const COLORS: Readonly<Record<Tone, string>> = {
  error: "editorError.foreground",
  info: "editorInfo.foreground",
  muted: "editorCodeLens.foreground",
  ok: "testing.iconPassed",
  warning: "editorWarning.foreground",
};

const REFRESH_DELAY_MS = 50;

/** Inline end-of-line annotations. Unchanged decoration sets are never re-applied. */
export class DecorationController implements vscode.Disposable {
  private readonly type = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  // Keyed by editor instance: a reopened file gets a new editor that has no decorations yet.
  private readonly applied = new WeakMap<vscode.TextEditor, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** Number of times decorations were pushed to an editor (used by integration tests). */
  applyCount = 0;

  constructor(
    private readonly deps: {
      views: DocumentViews;
      analysis: AnalysisService;
      config: () => ManifestLensConfig;
      now: () => number;
    }
  ) {
    this.disposables.push(
      this.type,
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === event.document) {
            this.applied.delete(editor);
          }
        }
        this.schedule();
      }),
      deps.analysis.onDidChange(() => {
        this.schedule();
      })
    );
    this.schedule();
  }

  schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.refreshAll();
    }, REFRESH_DELAY_MS);
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refresh(editor);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private refresh(editor: vscode.TextEditor): void {
    const { document } = editor;
    if (!isManifestDocument(document)) {
      return;
    }
    const config = this.deps.config();
    const options = config.showVersionStatus
      ? this.build(document, config)
      : [];
    const signature = JSON.stringify(
      options.map((option) => [
        option.range.start.line,
        option.range.start.character,
        option.renderOptions?.after?.contentText,
        option.renderOptions?.after?.color,
      ])
    );
    if (this.applied.get(editor) === signature) {
      return;
    }
    this.applied.set(editor, signature);
    this.applyCount += 1;
    editor.setDecorations(this.type, options);
  }

  private build(
    document: vscode.TextDocument,
    config: ManifestLensConfig
  ): vscode.DecorationOptions[] {
    const view = this.deps.views.view(document);
    if (!view) {
      return [];
    }
    const context: AnnotationContext = {
      minimumSeverity: config.annotations.minimumUpdateSeverity,
      now: this.deps.now(),
      prereleaseEnabled: config.prerelease.enabled,
      securityEnabled: config.security.enabled,
    };
    const decorate = (
      offset: number,
      text: string,
      tone: Tone,
      stale: boolean
    ): vscode.DecorationOptions => {
      const line = document.lineAt(document.positionAt(offset).line);
      return {
        range: new vscode.Range(line.range.end, line.range.end),
        renderOptions: {
          after: {
            color: new vscode.ThemeColor(COLORS[tone]),
            contentText: stale ? `${text} (stale)` : text,
            fontStyle: stale ? "italic" : "normal",
            margin: "0 0 0 2em",
          },
        },
      };
    };

    const options: vscode.DecorationOptions[] = [];
    const stale = view.state?.stale === true;
    if (
      view.state === undefined ||
      (view.state.status === "loading" && !view.state.analysis)
    ) {
      for (const declaration of view.parsed.declarations) {
        options.push(
          decorate(declaration.nameSpan.start, "⟳ checking…", "muted", false)
        );
      }
      return options;
    }
    for (const { analysis, declaration } of view.items) {
      const annotation = annotationOf(analysis, context);
      if (annotation.text !== "") {
        options.push(
          decorate(
            declaration.nameSpan.start,
            annotation.text,
            annotation.tone,
            stale
          )
        );
      }
    }
    return options;
  }
}
