import * as vscode from "vscode";

import type { DownloadsPort } from "../../application/ports";
import type { ManifestLensConfig } from "../../config/configuration-schema";
import { DEFAULT_REGISTRY } from "../../config/configuration-schema";
import { type HoverContext, hoverMarkdown } from "../../presentation/hover";
import type { DocumentViews } from "../services/document-view";

const DOWNLOADS_TIMEOUT_MS = 1500;
const TRUSTED_COMMANDS = [
  "manifestLens.updateDependency",
  "manifestLens.updateDependencyAndInstall",
];

const usesDefaultRegistry = (registry: string): boolean => {
  try {
    return new URL(registry).host === new URL(DEFAULT_REGISTRY).host;
  } catch {
    return false;
  }
};

/** Hover details for dependency names and specifiers. */
export class DependencyHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly deps: {
      views: DocumentViews;
      downloads: DownloadsPort;
      config: () => ManifestLensConfig;
      now: () => number;
    }
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const view = this.deps.views.view(document);
    if (!view) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    const hit = view.items.find(
      ({ declaration }) =>
        (offset >= declaration.nameSpan.start &&
          offset <= declaration.nameSpan.end) ||
        (offset >= declaration.valueSpan.start &&
          offset <= declaration.valueSpan.end)
    );
    if (!hit) {
      return undefined;
    }
    const config = this.deps.config();
    const downloads =
      hit.analysis.status !== "unsupported" &&
      usesDefaultRegistry(config.registry)
        ? await this.withTimeout(hit.analysis.registryName, token)
        : undefined;
    const context: HoverContext = {
      ...(downloads === undefined ? {} : { monthlyDownloads: downloads }),
      now: this.deps.now(),
      prereleaseEnabled: config.prerelease.enabled,
      ...(view.parsed.nodeEngine === undefined
        ? {}
        : { projectNodeEngine: view.parsed.nodeEngine }),
      showLatestHint: config.showLatestVersionHint,
    };
    const markdown = new vscode.MarkdownString(
      hoverMarkdown(hit.analysis, context)
    );
    markdown.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
    markdown.supportHtml = false;
    const { declaration } = hit;
    return new vscode.Hover(
      markdown,
      new vscode.Range(
        document.positionAt(declaration.nameSpan.start),
        document.positionAt(declaration.valueSpan.end)
      )
    );
  }

  private async withTimeout(
    name: string,
    token: vscode.CancellationToken
  ): Promise<number | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, DOWNLOADS_TIMEOUT_MS);
    const subscription = token.onCancellationRequested(() => {
      controller.abort();
    });
    try {
      return await this.deps.downloads.monthly(name, controller.signal);
    } finally {
      clearTimeout(timer);
      subscription.dispose();
    }
  }
}
