import * as vscode from "vscode";

import { isManifestDocument, isPackageJson } from "../services/uri";

/** Session-level UI toggles and the context keys that menus depend on. */
export class UiState implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private suggestions: boolean;
  readonly onDidChange = this.emitter.event;

  constructor(showOnStartup: boolean) {
    this.suggestions = showOnStartup;
    void this.publish();
  }

  get suggestionsVisible(): boolean {
    return this.suggestions;
  }

  setSuggestionsVisible(visible: boolean): void {
    this.suggestions = visible;
    void this.publish();
    this.emitter.fire();
  }

  async publish(prereleaseEnabled?: boolean, busy?: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const manifest =
      editor !== undefined && isManifestDocument(editor.document);
    await Promise.all([
      vscode.commands.executeCommand(
        "setContext",
        "manifestLens.suggestionsVisible",
        this.suggestions
      ),
      vscode.commands.executeCommand(
        "setContext",
        "manifestLens.activeManifest",
        manifest
      ),
      vscode.commands.executeCommand(
        "setContext",
        "manifestLens.activeManifestIsPackageJson",
        manifest && editor !== undefined && isPackageJson(editor.document)
      ),
      ...(prereleaseEnabled === undefined
        ? []
        : [
            vscode.commands.executeCommand(
              "setContext",
              "manifestLens.prereleaseEnabled",
              prereleaseEnabled
            ),
          ]),
      ...(busy === undefined
        ? []
        : [
            vscode.commands.executeCommand(
              "setContext",
              "manifestLens.busy",
              busy
            ),
          ]),
    ]);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
