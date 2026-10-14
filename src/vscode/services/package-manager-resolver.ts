import * as vscode from "vscode";

import type {
  PackageManagerDetection,
  PackageManagerName,
} from "../../domain/package-manager/types";
import { nodeFileProbe } from "../../infrastructure/filesystem/node-file-probe";
import { detectPackageManager } from "../../infrastructure/package-manager/detect";
import { dirOf } from "./uri";

/** Resolves (and caches) the package manager and install root for manifests. */
export class PackageManagerResolver implements vscode.Disposable {
  private readonly cache = new Map<string, PackageManagerDetection>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidResolve = this.emitter.event;

  constructor(private readonly configured: () => PackageManagerName | "auto") {}

  /** The cached detection, starting a background resolution when unknown. */
  peek(manifestUri: string): PackageManagerDetection | undefined {
    const dir = dirOf(manifestUri);
    if (dir === undefined) {
      return undefined;
    }
    const cached = this.cache.get(dir);
    if (!cached) {
      void this.resolveDir(dir, manifestUri).then(() => {
        this.emitter.fire();
      });
    }
    return cached;
  }

  async resolve(manifestUri: string): Promise<PackageManagerDetection> {
    const dir = dirOf(manifestUri);
    if (dir === undefined) {
      return {
        evidence: "non-file manifest",
        manager: "npm",
        root: "",
      };
    }
    return await this.resolveDir(dir, manifestUri);
  }

  async resolveForDir(manifestDir: string): Promise<PackageManagerDetection> {
    const folder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.file(manifestDir)
    );
    return await this.detect(manifestDir, folder?.uri.fsPath ?? manifestDir);
  }

  invalidate(): void {
    this.cache.clear();
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private async resolveDir(
    dir: string,
    manifestUri: string
  ): Promise<PackageManagerDetection> {
    const cached = this.cache.get(dir);
    if (cached) {
      return cached;
    }
    const folder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.parse(manifestUri)
    );
    const detection = await this.detect(dir, folder?.uri.fsPath ?? dir);
    this.cache.set(dir, detection);
    return detection;
  }

  private async detect(
    manifestDir: string,
    boundary: string
  ): Promise<PackageManagerDetection> {
    return await detectPackageManager({
      boundary,
      configured: this.configured(),
      manifestDir,
      probe: nodeFileProbe,
    });
  }
}
