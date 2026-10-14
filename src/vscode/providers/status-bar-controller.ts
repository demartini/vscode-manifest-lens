import * as vscode from "vscode";

import { statusFor } from "../../presentation/status";
import type { AnalysisService } from "../services/analysis-service";
import type { PackageManagerResolver } from "../services/package-manager-resolver";
import { isManifestDocument } from "../services/uri";

const BACKGROUNDS: Readonly<Record<string, vscode.ThemeColor | undefined>> = {
  error: new vscode.ThemeColor("statusBarItem.errorBackground"),
  warning: new vscode.ThemeColor("statusBarItem.warningBackground"),
};

/** A compact summary of the active manifest in the status bar. */
export class StatusBarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "manifestLens.status",
    vscode.StatusBarAlignment.Left,
    100
  );
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly deps: {
      analysis: AnalysisService;
      packageManager: PackageManagerResolver;
    }
  ) {
    this.item.name = "Manifest Lens";
    this.item.command = "manifestLens.checkUpdates";
    this.disposables.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.update();
      }),
      deps.analysis.onDidChange(() => {
        this.update();
      }),
      deps.packageManager.onDidResolve(() => {
        this.update();
      })
    );
    this.update();
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    if (!(editor && isManifestDocument(editor.document))) {
      this.item.hide();
      return;
    }
    const uri = editor.document.uri.toString();
    const state = this.deps.analysis.get(uri);
    const label = this.deps.packageManager.peek(uri)?.manager ?? "pkg";
    let model;
    if (state?.analysis) {
      model = statusFor(label, {
        kind: "ready",
        partial: state.analysis.partial || state.status === "error",
        summary: state.analysis.summary,
      });
    } else if (state?.status === "error") {
      model = statusFor(label, {
        kind: "error",
        message: state.error?.message ?? "Analysis failed.",
      });
    } else {
      model = statusFor(label, { kind: "loading" });
    }
    this.item.text = model.text;
    this.item.tooltip = model.tooltip;
    this.item.backgroundColor = BACKGROUNDS[model.tone];
    this.item.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
