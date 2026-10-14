import type * as vscode from "vscode";

import type { DependencyAnalysis } from "../../domain/dependency/analysis";
import { parseManifestText } from "../../domain/manifest/parse";
import type {
  DependencyDeclaration,
  ParsedManifest,
} from "../../domain/manifest/types";
import type { AnalysisService, ManifestState } from "./analysis-service";

export interface DocumentItem {
  readonly analysis: DependencyAnalysis;
  /** The declaration as it appears in the document right now. */
  readonly declaration: DependencyDeclaration;
}

export interface DocumentView {
  readonly parsed: ParsedManifest;
  readonly state: ManifestState | undefined;
  readonly items: readonly DocumentItem[];
}

interface CacheEntry {
  readonly version: number;
  readonly parsed: ParsedManifest;
}

/**
 * Maps analysis results onto the current text of a document. The text is
 * re-parsed (cheaply, and cached per version) so ranges stay correct while the
 * user types; results whose specifier changed since analysis are left out.
 */
export class DocumentViews {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly analysis: AnalysisService) {}

  parse(document: vscode.TextDocument): ParsedManifest | undefined {
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached?.version === document.version) {
      return cached.parsed;
    }
    const parsed = parseManifestText(document.uri.path, document.getText());
    if (parsed) {
      this.cache.set(key, { parsed, version: document.version });
    }
    return parsed;
  }

  forget(uri: string): void {
    this.cache.delete(uri);
  }

  view(document: vscode.TextDocument): DocumentView | undefined {
    const parsed = this.parse(document);
    if (!parsed) {
      return undefined;
    }
    const state = this.analysis.get(document.uri.toString());
    const byId = new Map(
      parsed.declarations.map((declaration) => [declaration.id, declaration])
    );
    const items: DocumentItem[] = [];
    for (const analysis of state?.analysis?.items ?? []) {
      const declaration = byId.get(analysis.declaration.id);
      if (declaration?.specifier === analysis.declaration.specifier) {
        items.push({ analysis, declaration });
      }
    }
    return { items, parsed, state };
  }
}
