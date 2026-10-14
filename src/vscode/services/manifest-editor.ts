import * as vscode from "vscode";

import type {
  ManifestDocument,
  ManifestEditorPort,
} from "../../application/ports";
import type { ManifestEdit } from "../../domain/manifest/types";
import { ManifestLensError } from "../../shared/errors";
import { type Result, err, ok } from "../../shared/result";
import { fsPathOf } from "./uri";

/** Applies manifest edits through the VS Code document model so undo history is preserved. */
export class VsCodeManifestEditor implements ManifestEditorPort {
  async read(uri: string): Promise<ManifestDocument> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(uri)
    );
    return {
      isDirty: document.isDirty,
      text: document.getText(),
      uri,
      version: document.version,
    };
  }

  async apply(
    uri: string,
    edits: readonly ManifestEdit[],
    expectedVersion: number
  ): Promise<Result<void, ManifestLensError>> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(uri)
    );
    if (document.version !== expectedVersion) {
      return err(
        new ManifestLensError(
          "stale",
          `${uri} changed while the update was being prepared.`
        )
      );
    }
    const edit = new vscode.WorkspaceEdit();
    for (const item of edits) {
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(item.span.start),
          document.positionAt(item.span.end)
        ),
        item.replacement
      );
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      return err(
        new ManifestLensError("unexpected", "VS Code rejected the edit.")
      );
    }
    if (document.isDirty && !(await document.save())) {
      return err(new ManifestLensError("unexpected", `Could not save ${uri}.`));
    }
    return ok();
  }

  fsPath(uri: string): string | undefined {
    return fsPathOf(uri);
  }
}
