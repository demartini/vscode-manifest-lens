import * as vscode from "vscode";

import type { ManifestLensConfig } from "../../config/configuration-schema";
import {
  type DependencyAnalysis,
  currentAdvisories,
  type ManifestAnalysis,
} from "../../domain/dependency/analysis";
import type { DependencySection } from "../../domain/manifest/types";
import { compareSeverity } from "../../domain/vulnerability/advisory";
import { blockersOf } from "../../presentation/annotation";
import {
  type DashboardFilters,
  NO_FILTERS,
  hasActiveFilters,
  matchesFilters,
} from "../../presentation/filters";
import { type HoverContext, hoverMarkdown } from "../../presentation/hover";
import { clip } from "../../presentation/markdown";
import type {
  AnalysisService,
  ManifestState,
} from "../services/analysis-service";

export type DashboardNode =
  | { readonly kind: "manifest"; readonly uri: string }
  | {
      readonly kind: "section";
      readonly uri: string;
      readonly sectionId: string;
    }
  | { readonly kind: "dependency"; readonly key: string }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly group: "advisories" | "conflicts";
    }
  | {
      readonly kind: "detail";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly icon: string;
      readonly url?: string;
      readonly contextValue?: string;
    };

const SECTION_LABEL: Readonly<Record<DependencySection, string>> = {
  catalog: "Catalog",
  dependencies: "Dependencies",
  devDependencies: "Dev Dependencies",
  optionalDependencies: "Optional Dependencies",
  overrides: "Overrides",
  peerDependencies: "Peer Dependencies",
  resolutions: "Resolutions",
};

const ICONS: Readonly<Record<DependencyAnalysis["status"], vscode.ThemeIcon>> =
  {
    blocked: new vscode.ThemeIcon(
      "circle-slash",
      new vscode.ThemeColor("list.warningForeground")
    ),
    error: new vscode.ThemeIcon(
      "warning",
      new vscode.ThemeColor("list.warningForeground")
    ),
    unpublished: new vscode.ThemeIcon(
      "warning",
      new vscode.ThemeColor("list.warningForeground")
    ),
    unsupported: new vscode.ThemeIcon(
      "circle-outline",
      new vscode.ThemeColor("disabledForeground")
    ),
    "up-to-date": new vscode.ThemeIcon(
      "check",
      new vscode.ThemeColor("testing.iconPassed")
    ),
    update: new vscode.ThemeIcon(
      "arrow-up",
      new vscode.ThemeColor("editorInfo.foreground")
    ),
  };

const REFRESH_DELAY_MS = 120;

/** The sidebar dashboard: manifests → sections → dependencies → details. */
export class DashboardProvider
  implements vscode.TreeDataProvider<DashboardNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<
    DashboardNode | undefined
  >();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private filters: DashboardFilters = NO_FILTERS;
  private selectedManifest: string | undefined;
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly deps: {
      analysis: AnalysisService;
      config: () => ManifestLensConfig;
      now: () => number;
      workspaceManifests: () => string[];
    }
  ) {
    this.disposables.push(
      this.emitter,
      deps.analysis.onDidChange(() => {
        this.refresh();
      })
    );
  }

  get activeFilters(): DashboardFilters {
    return this.filters;
  }

  get selected(): string | undefined {
    return this.selectedManifest;
  }

  setFilters(filters: DashboardFilters): void {
    this.filters = filters;
    this.refresh();
  }

  selectManifest(uri: string | undefined): void {
    this.selectedManifest = uri;
    this.refresh();
  }

  refresh(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.emitter.fire(undefined);
    }, REFRESH_DELAY_MS);
  }

  describeFilters(): string | undefined {
    const parts: string[] = [];
    if (this.filters.vulnerableOnly) {
      parts.push("vulnerable");
    }
    if (this.filters.blockedOnly) {
      parts.push("blocked");
    }
    if (this.filters.severities.length > 0) {
      parts.push(this.filters.severities.join("/"));
    }
    if (this.selectedManifest) {
      parts.push(
        vscode.workspace.asRelativePath(vscode.Uri.parse(this.selectedManifest))
      );
    }
    return parts.length > 0 ? `Filter: ${parts.join(", ")}` : undefined;
  }

  getChildren(element?: DashboardNode): DashboardNode[] {
    if (!element) {
      return this.manifestUris().map((uri) => ({
        kind: "manifest" as const,
        uri,
      }));
    }
    switch (element.kind) {
      case "manifest": {
        return this.sectionsOf(element.uri);
      }
      case "section": {
        return this.dependenciesOf(element.uri, element.sectionId);
      }
      case "dependency": {
        return this.detailsOf(element.key);
      }
      case "group": {
        return this.groupChildren(element.key, element.group);
      }
      default: {
        return [];
      }
    }
  }

  getTreeItem(node: DashboardNode): vscode.TreeItem {
    switch (node.kind) {
      case "manifest": {
        return this.manifestItem(node.uri);
      }
      case "section": {
        return this.sectionItem(node.uri, node.sectionId);
      }
      case "dependency": {
        return this.dependencyItem(node.key);
      }
      case "group": {
        return this.groupItem(node.key, node.group);
      }
      default: {
        return this.detailItem(node);
      }
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

  /** The manifests the dashboard currently shows (honours the manifest selection). */
  visibleManifests(): string[] {
    return this.manifestUris();
  }

  private manifestUris(): string[] {
    if (this.selectedManifest) {
      return [this.selectedManifest];
    }
    const uris = new Set([
      ...this.deps.workspaceManifests(),
      ...this.deps.analysis.states().map((s) => s.uri),
    ]);
    return [...uris]
      .filter((uri) =>
        hasActiveFilters(this.filters)
          ? this.visibleItems(uri).length > 0
          : true
      )
      .toSorted((a, b) => a.localeCompare(b));
  }

  private analysisOf(uri: string): ManifestAnalysis | undefined {
    return this.deps.analysis.get(uri)?.analysis;
  }

  private visibleItems(uri: string): DependencyAnalysis[] {
    return (this.analysisOf(uri)?.items ?? []).filter((item) =>
      matchesFilters(item, this.filters)
    );
  }

  private sectionsOf(uri: string): DashboardNode[] {
    const state = this.deps.analysis.get(uri);
    const sections = state?.parsed?.sections ?? [];
    const visible = new Set(
      this.visibleItems(uri).map((item) => item.declaration.id)
    );
    return sections
      .filter((section) => section.declarationIds.some((id) => visible.has(id)))
      .map((section) => ({
        kind: "section" as const,
        sectionId: section.id,
        uri,
      }));
  }

  private dependenciesOf(uri: string, sectionId: string): DashboardNode[] {
    const section = this.deps.analysis
      .get(uri)
      ?.parsed?.sections.find((candidate) => candidate.id === sectionId);
    if (!section) {
      return [];
    }
    const ids = new Set(section.declarationIds);
    return this.visibleItems(uri)
      .filter((item) => ids.has(item.declaration.id))
      .map((item) => ({ key: item.key, kind: "dependency" as const }));
  }

  private detailsOf(key: string): DashboardNode[] {
    const item = this.deps.analysis.findItem(key);
    if (!item) {
      return [];
    }
    const nodes: DashboardNode[] = [];
    const rows: [string, string | undefined][] = [
      ["Declared", item.declaration.specifier],
      ["Installed", item.installedVersion],
      ["Resolves to", item.resolvedVersion],
      ["Latest", item.latestVersion],
    ];
    for (const [label, value] of rows) {
      if (value !== undefined) {
        nodes.push({
          description: value,
          icon: "symbol-string",
          id: `${key}:${label}`,
          kind: "detail",
          label,
        });
      }
    }
    if (item.deprecation) {
      nodes.push({
        description: clip(item.deprecation.message, 80),
        icon: "circle-slash",
        id: `${key}:dep`,
        kind: "detail",
        label: "Deprecated",
      });
    }
    if (item.registry.kind === "error") {
      nodes.push({
        description: clip(item.registry.error.message, 80),
        icon: "warning",
        id: `${key}:err`,
        kind: "detail",
        label: "Registry error",
      });
    }
    const target = item.selection?.target;
    if (target && (item.peer[target.version]?.conflicts.length ?? 0) > 0) {
      nodes.push({ group: "conflicts", key, kind: "group" });
    }
    if (currentAdvisories(item).length > 0) {
      nodes.push({ group: "advisories", key, kind: "group" });
    }
    return nodes;
  }

  private groupChildren(
    key: string,
    group: "advisories" | "conflicts"
  ): DashboardNode[] {
    const item = this.deps.analysis.findItem(key);
    if (!item) {
      return [];
    }
    if (group === "advisories") {
      return currentAdvisories(item)
        .toSorted((a, b) =>
          compareSeverity(a.advisory.severity, b.advisory.severity)
        )
        .map((match) => ({
          contextValue: "advisory",
          description: `${match.advisory.severity}${match.fixedVersions[0] ? ` · fixed in ${match.fixedVersions[0]}` : " · no fix"}`,
          icon: "shield",
          id: `${key}:${match.advisory.id}`,
          kind: "detail" as const,
          label: match.advisory.id,
          ...(match.advisory.references[0]
            ? { url: match.advisory.references[0].url }
            : {}),
        }));
    }
    const target = item.selection?.target;
    const conflicts = target
      ? (item.peer[target.version]?.conflicts ?? [])
      : [];
    return conflicts.map((conflict, index) => ({
      description: `${conflict.requiredRange}${conflict.resolution ? ` · fixed by ${conflict.resolution.package}@${conflict.resolution.version}` : ""}`,
      icon: conflict.confidence === "confirmed" ? "circle-slash" : "question",
      id: `${key}:conflict:${index}`,
      kind: "detail" as const,
      label: conflict.blocker,
    }));
  }

  private manifestItem(uri: string): vscode.TreeItem {
    const state = this.deps.analysis.get(uri);
    const item = new vscode.TreeItem(
      vscode.workspace.asRelativePath(vscode.Uri.parse(uri)),
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.resourceUri = vscode.Uri.parse(uri);
    item.iconPath = new vscode.ThemeIcon("package");
    item.contextValue = "manifest";
    item.description = this.manifestDescription(state);
    item.id = `manifest:${uri}`;
    item.command = {
      arguments: [{ kind: "manifest", uri }],
      command: "manifestLens.revealDeclaration",
      title: "Open",
    };
    return item;
  }

  private manifestDescription(state: ManifestState | undefined): string {
    if (!state || (state.status === "loading" && !state.analysis)) {
      return "analyzing…";
    }
    if (state.status === "error" && !state.analysis) {
      return "analysis failed";
    }
    const summary = state.analysis?.summary;
    if (!summary) {
      return "";
    }
    const parts = [
      summary.updates > 0 ? `${summary.updates}↑` : "",
      summary.blocked > 0 ? `${summary.blocked}✋` : "",
      summary.vulnerable > 0 ? `${summary.vulnerable}⚠` : "",
      summary.errors > 0 ? `${summary.errors}?` : "",
    ].filter((part) => part !== "");
    return parts.length > 0 ? parts.join(" ") : "✓";
  }

  private sectionItem(uri: string, sectionId: string): vscode.TreeItem {
    const section = this.deps.analysis
      .get(uri)
      ?.parsed?.sections.find((candidate) => candidate.id === sectionId);
    const label = section
      ? `${SECTION_LABEL[section.section]}${section.catalog ? ` (${section.catalog})` : ""}`
      : sectionId;
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.Expanded
    );
    const members = this.visibleItems(uri).filter((entry) =>
      section?.declarationIds.includes(entry.declaration.id)
    );
    const updates = members.filter((entry) => entry.status === "update").length;
    item.description =
      updates > 0
        ? `${updates} update${updates === 1 ? "" : "s"}`
        : `${members.length}`;
    item.contextValue = "section";
    item.iconPath = new vscode.ThemeIcon("list-tree");
    item.id = `section:${uri}:${sectionId}`;
    item.command = {
      arguments: [{ kind: "section", sectionId, uri }],
      command: "manifestLens.revealDeclaration",
      title: "Go to section",
    };
    return item;
  }

  private dependencyItem(key: string): vscode.TreeItem {
    const analysis = this.deps.analysis.findItem(key);
    if (!analysis) {
      return new vscode.TreeItem("(unavailable)");
    }
    const item = new vscode.TreeItem(
      analysis.declaration.name,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    const target = analysis.selection?.target;
    const advisories = currentAdvisories(analysis).length;
    const parts: string[] = [analysis.declaration.specifier];
    if (
      analysis.installedVersion &&
      analysis.installedVersion !== analysis.declaration.specifier
    ) {
      parts.push(`installed ${analysis.installedVersion}`);
    }
    if (target) {
      const label =
        analysis.status === "blocked"
          ? `✋ ${target.version} (${blockersOf(analysis, target.version).join(", ")})`
          : `→ ${target.version} (${target.severity})`;
      parts.push(label);
    } else if (analysis.status === "error") {
      parts.push("unavailable");
    } else if (analysis.status === "unpublished") {
      parts.push("✗ not published");
    }
    if (advisories > 0) {
      parts.push(`⚠ ${advisories}`);
    }
    item.description = parts.join("  ");
    item.iconPath =
      advisories > 0
        ? new vscode.ThemeIcon(
            "shield",
            new vscode.ThemeColor("list.errorForeground")
          )
        : ICONS[analysis.status];
    const hoverContext: HoverContext = {
      now: this.deps.now(),
      prereleaseEnabled: this.deps.config().prerelease.enabled,
      showLatestHint: true,
    };
    const tooltip = new vscode.MarkdownString(
      hoverMarkdown(analysis, hoverContext)
    );
    tooltip.isTrusted = false;
    item.tooltip = tooltip;
    const kind = {
      blocked: "blocked",
      error: "error",
      unpublished: "unpublished",
      unsupported: "unsupported",
      "up-to-date": "current",
      update: "updatable",
    }[analysis.status];
    item.contextValue = `dependency.${kind}`;
    item.id = `dependency:${key}`;
    item.command = {
      arguments: [{ key, kind: "dependency" }],
      command: "manifestLens.revealDeclaration",
      title: "Go to declaration",
    };
    return item;
  }

  private groupItem(
    key: string,
    group: "advisories" | "conflicts"
  ): vscode.TreeItem {
    const item = this.deps.analysis.findItem(key);
    const advisoryCount = item ? currentAdvisories(item).length : 0;
    const count =
      group === "advisories"
        ? advisoryCount
        : this.groupChildren(key, group).length;
    const node = new vscode.TreeItem(
      group === "advisories"
        ? `Advisories (${count})`
        : `Peer conflicts (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    node.iconPath = new vscode.ThemeIcon(
      group === "advisories" ? "shield" : "circle-slash"
    );
    node.id = `group:${key}:${group}`;
    return node;
  }

  private detailItem(
    node: Extract<DashboardNode, { kind: "detail" }>
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.id = node.id;
    if (node.contextValue) {
      item.contextValue = node.contextValue;
    }
    if (node.url) {
      item.command = {
        arguments: [node.url],
        command: "manifestLens.openAdvisory",
        title: "Open advisory",
      };
    }
    return item;
  }
}
