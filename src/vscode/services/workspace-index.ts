import * as vscode from "vscode";

import type { CatalogEntry } from "../../application/analyze-manifest/analyze-manifest";
import {
  manifestFormatOf,
  parseManifestText,
} from "../../domain/manifest/parse";
import type { ParsedManifest } from "../../domain/manifest/types";
import type { Logger } from "../../shared/logger";
import { mapLimit } from "../../shared/utilities/concurrency";
import { dirOf, isIgnoredManifestPath } from "./uri";

export interface IndexedManifest {
  readonly uri: string;
  readonly dir: string | undefined;
  readonly parsed: ParsedManifest;
  readonly text: string;
  readonly version: number;
}

const MANIFEST_GLOB =
  "**/{package.json,pnpm-workspace.yaml,pnpm-workspace.yml,.yarnrc.yml}";
const EXCLUDE_GLOB = "**/{node_modules,.git,.yarn,dist,out}/**";
const MAX_MANIFESTS = 2000;
const READ_CONCURRENCY = 16;

const decoder = new TextDecoder();

/** Keeps a parsed view of every manifest in the workspace, updated incrementally. */
export class WorkspaceIndex implements vscode.Disposable {
  private readonly entries = new Map<string, IndexedManifest>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private scanned = false;
  readonly onDidChange = this.emitter.event;

  constructor(private readonly logger: Logger) {
    const watcher = vscode.workspace.createFileSystemWatcher(MANIFEST_GLOB);
    this.disposables.push(
      watcher,
      this.emitter,
      watcher.onDidCreate((uri) => void this.refreshOne(uri.toString())),
      watcher.onDidChange((uri) => void this.refreshOne(uri.toString())),
      watcher.onDidDelete((uri) => {
        this.remove(uri.toString());
      })
    );
  }

  get hasScanned(): boolean {
    return this.scanned;
  }

  all(): IndexedManifest[] {
    return [...this.entries.values()].toSorted((a, b) =>
      a.uri.localeCompare(b.uri)
    );
  }

  get(uri: string): IndexedManifest | undefined {
    return this.entries.get(uri);
  }

  /** Discovers every manifest in the workspace folders. */
  async scan(): Promise<void> {
    const files = await vscode.workspace.findFiles(
      MANIFEST_GLOB,
      EXCLUDE_GLOB,
      MAX_MANIFESTS
    );
    const seen = new Set(files.map((file) => file.toString()));
    for (const uri of this.entries.keys()) {
      if (!seen.has(uri) && !this.isOpen(uri)) {
        this.entries.delete(uri);
      }
    }
    await mapLimit(
      files,
      READ_CONCURRENCY,
      async (file) => await this.refreshOne(file.toString(), false)
    );
    this.scanned = true;
    this.logger.info(`Indexed ${this.entries.size} manifest(s).`);
    this.emitter.fire();
  }

  /** Reads the freshest text (unsaved buffer first) for a manifest. */
  async read(
    uri: string
  ): Promise<{ text: string; version: number } | undefined> {
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri
    );
    if (open) {
      return { text: open.getText(), version: open.version };
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
      return { text: decoder.decode(bytes), version: 0 };
    } catch {
      return undefined;
    }
  }

  async refreshOne(uri: string, notify = true): Promise<void> {
    if (manifestFormatOf(uri) === undefined || isIgnoredManifestPath(uri)) {
      return;
    }
    const read = await this.read(uri);
    if (!read) {
      this.remove(uri);
      return;
    }
    const parsed = parseManifestText(uri, read.text);
    if (!parsed) {
      return;
    }
    this.entries.set(uri, {
      dir: dirOf(uri),
      parsed,
      text: read.text,
      uri,
      version: read.version,
    });
    if (notify) {
      this.emitter.fire();
    }
  }

  remove(uri: string): void {
    if (this.entries.delete(uri)) {
      this.emitter.fire();
    }
  }

  localPackageNames(): Set<string> {
    const names = new Set<string>();
    for (const entry of this.entries.values()) {
      if (
        entry.parsed.format === "package-json" &&
        entry.parsed.name !== undefined
      ) {
        names.add(entry.parsed.name);
      }
    }
    return names;
  }

  /** Dependency names declared by the other manifests in the same workspace folder. */
  siblingDependencyNames(manifestUri: string): string[] {
    const folder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.parse(manifestUri)
    );
    const names = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.uri === manifestUri || entry.parsed.format !== "package-json") {
        continue;
      }
      const other = vscode.workspace.getWorkspaceFolder(
        vscode.Uri.parse(entry.uri)
      );
      if (other?.uri.toString() !== folder?.uri.toString()) {
        continue;
      }
      for (const declaration of entry.parsed.declarations) {
        if (
          declaration.section === "dependencies" ||
          declaration.section === "devDependencies"
        ) {
          names.add(declaration.name);
        }
      }
    }
    return [...names];
  }

  /** Finds the catalog entry for a `catalog:` reference, searching enclosing directories. */
  resolveCatalog(
    manifestUri: string,
    catalog: string,
    packageName: string
  ): CatalogEntry | undefined {
    const byDir = new Map<string, IndexedManifest[]>();
    for (const entry of this.entries.values()) {
      if (entry.dir !== undefined) {
        byDir.set(entry.dir, [...(byDir.get(entry.dir) ?? []), entry]);
      }
    }
    let dir = dirOf(manifestUri);
    while (dir !== undefined) {
      for (const candidate of byDir.get(dir) ?? []) {
        const match = candidate.parsed.declarations.find(
          (declaration) =>
            declaration.section === "catalog" &&
            declaration.name === packageName &&
            (declaration.catalog ?? "") ===
              (catalog === "default" ? "" : catalog)
        );
        if (match) {
          return {
            source: { declaration: match, manifestUri: candidate.uri },
            specifier: match.specifier,
          };
        }
      }
      const parent = dir.replace(/[\\/][^\\/]*$/u, "");
      dir = parent === dir || parent === "" ? undefined : parent;
    }
    return undefined;
  }

  private isOpen(uri: string): boolean {
    return vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === uri
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
