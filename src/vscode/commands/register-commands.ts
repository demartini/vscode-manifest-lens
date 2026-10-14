import * as vscode from "vscode";

import { CONFIG_SECTION } from "../../config/configuration";
import type { ManifestLensConfig } from "../../config/configuration-schema";
import { currentAdvisories } from "../../domain/dependency/analysis";
import type { UpdateScope } from "../../domain/update-plan/plan";
import { compareSeverity } from "../../domain/vulnerability/advisory";
import type { OutputChannelLogger } from "../../infrastructure/logging/output-channel-logger";
import { type DashboardFilters, NO_FILTERS } from "../../presentation/filters";
import { clip } from "../../presentation/markdown";
import type { UiState } from "../providers/ui-state";
import type { AnalysisService } from "../services/analysis-service";
import type { PackageManagerResolver } from "../services/package-manager-resolver";
import { isManifestDocument, isPackageJson } from "../services/uri";
import type { WorkspaceIndex } from "../services/workspace-index";
import type { DashboardProvider } from "../tree-view/dashboard-provider";
import type { OperationRunner } from "./operation-runner";
import type { UpdateController } from "./update-controller";

export interface CommandServices {
  readonly analysis: AnalysisService;
  readonly index: WorkspaceIndex;
  readonly ui: UiState;
  readonly controller: UpdateController;
  readonly runner: OperationRunner;
  readonly dashboard: DashboardProvider;
  readonly resolver: PackageManagerResolver;
  readonly logger: OutputChannelLogger;
  readonly config: () => ManifestLensConfig;
  readonly clearCaches: () => void;
  readonly cacheReport: () => string[];
}

const SEVERITY_CHOICES = ["major", "minor", "patch", "prerelease"] as const;

const isWebUrl = (value: string): boolean => /^https?:\/\//iu.test(value);

/** Accepts a dependency key string or a tree node and returns the dependency key. */
const keyOf = (argument: unknown): string | undefined => {
  if (typeof argument === "string") {
    return argument;
  }
  if (
    typeof argument === "object" &&
    argument !== null &&
    "key" in argument &&
    typeof argument.key === "string"
  ) {
    return argument.key;
  }
  return undefined;
};

const uriOf = (argument: unknown): string | undefined => {
  if (typeof argument === "string") {
    return argument;
  }
  if (
    typeof argument === "object" &&
    argument !== null &&
    "uri" in argument &&
    typeof argument.uri === "string"
  ) {
    return argument.uri;
  }
  return undefined;
};

const sectionIdOf = (argument: unknown): string | undefined => {
  if (
    typeof argument === "object" &&
    argument !== null &&
    "sectionId" in argument &&
    typeof argument.sectionId === "string"
  ) {
    return argument.sectionId;
  }
  return undefined;
};

const activeManifest = (): vscode.TextDocument | undefined => {
  const document = vscode.window.activeTextEditor?.document;
  return document && isManifestDocument(document) ? document : undefined;
};

const requireManifest = (): vscode.TextDocument | undefined => {
  const document = activeManifest();
  if (!document) {
    void vscode.window.showInformationMessage(
      "Manifest Lens: open a package.json or pnpm-workspace.yaml first."
    );
  }
  return document;
};

/** Registers every contributed command. */
export function registerCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const { analysis, controller, dashboard, index, logger, ui } = services;
  const register = (
    id: string,
    handler: (...args: unknown[]) => unknown
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `manifestLens.${id}`,
        async (...args: unknown[]) => {
          try {
            await handler(...args);
          } catch (error) {
            logger.error(`Command ${id} failed`, error);
            void vscode.window.showErrorMessage(
              `Manifest Lens: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      )
    );
  };

  const setSetting = (key: string, value: unknown): Thenable<void> =>
    vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(key, value, vscode.ConfigurationTarget.Global);

  const pickDependency = async (
    statuses: readonly string[]
  ): Promise<string | undefined> => {
    const document = requireManifest();
    const items =
      analysis
        .get(document?.uri.toString() ?? "")
        ?.analysis?.items.filter((item) => statuses.includes(item.status)) ??
      [];
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        "Manifest Lens: no matching dependencies."
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({
        description: `${item.declaration.specifier} → ${item.selection?.target?.version ?? ""}`,
        key: item.key,
        label: item.declaration.name,
      })),
      { placeHolder: "Select a dependency" }
    );
    return picked?.key;
  };

  const bulk = async (
    scope: UpdateScope,
    argument?: unknown
  ): Promise<void> => {
    const fromNode = uriOf(argument);
    let uris: string[];
    if (fromNode) {
      uris = [fromNode];
    } else {
      const document = activeManifest();
      uris = document
        ? [document.uri.toString()]
        : analysis
            .states()
            .filter((state) => state.analysis)
            .map((state) => state.uri);
    }
    await controller.bulk({ scope, uris });
  };

  const dashboardBulk = async (scope: UpdateScope): Promise<void> => {
    const uris = dashboard
      .visibleManifests()
      .filter((uri) => analysis.get(uri)?.analysis);
    if (uris.length === 0) {
      void vscode.window.showInformationMessage(
        'Manifest Lens: nothing has been analyzed yet. Run "Analyze workspace dependencies" first.'
      );
      return;
    }
    await controller.bulk({ scope, uris });
  };

  register("dashboard.updateAll", async () => await dashboardBulk("all"));
  register("dashboard.updatePatch", async () => await dashboardBulk("patch"));
  register("checkUpdates", async () => {
    const document = requireManifest();
    if (document) {
      await analysis.analyzeNow(document.uri.toString());
    }
  });
  register("refresh", async () => {
    services.clearCaches();
    const document = activeManifest();
    if (document) {
      analysis.request(document.uri.toString(), { immediate: true });
    }
    analysis.requestAll({ immediate: true });
  });
  register("showSuggestions", () => {
    ui.setSuggestionsVisible(true);
  });
  register("hideSuggestions", () => {
    ui.setSuggestionsVisible(false);
  });
  register("showPrerelease", () => setSetting("prerelease.enabled", true));
  register("hidePrerelease", () => setSetting("prerelease.enabled", false));
  register("updateAll", async (argument) => await bulk("all", argument));
  register("updateMajor", async (argument) => await bulk("major", argument));
  register("updateMinor", async (argument) => await bulk("minor", argument));
  register("updatePatch", async (argument) => await bulk("patch", argument));
  register("sortDependencies", async () => {
    const document = requireManifest();
    if (document && isPackageJson(document)) {
      await controller.sortDependencies(document);
    } else if (document) {
      void vscode.window.showInformationMessage(
        "Manifest Lens: sorting is only available for package.json."
      );
    }
  });
  register("install", async (argument) => {
    const uri = uriOf(argument) ?? requireManifest()?.uri.toString();
    if (uri) {
      await controller.installManifest(uri);
    }
  });
  register("openDashboard", () =>
    vscode.commands.executeCommand("manifestLens.dashboard.focus")
  );
  register("analyzeWorkspace", async () => {
    await services.runner.run("Analyzing workspace", async () => {
      await analysis.analyzeWorkspace({ force: true, rescan: true });
    });
  });
  register("checkVulnerabilities", async () => {
    if (!services.config().security.enabled) {
      const choice = await vscode.window.showInformationMessage(
        "Manifest Lens: vulnerability checks are disabled (manifestLens.security.enabled).",
        "Enable"
      );
      if (choice) {
        await setSetting("security.enabled", true);
      }
      return;
    }
    await analysis.analyzeWorkspace({ force: true });
    const states = analysis
      .states()
      .flatMap((state) => (state.analysis ? [state.analysis] : []));
    const vulnerable = states.reduce(
      (total, current) => total + current.summary.vulnerable,
      0
    );
    const advisories = states.reduce(
      (total, current) => total + current.summary.advisories,
      0
    );
    const partial = states.some((current) => current.partial);
    const text =
      vulnerable === 0 && !partial
        ? "no known advisories affect the analyzed versions."
        : `${vulnerable} vulnerable ${vulnerable === 1 ? "dependency" : "dependencies"}, ${advisories} distinct ${advisories === 1 ? "advisory" : "advisories"}${partial ? " (some data was unavailable)" : ""}.`;
    const choice = await vscode.window.showInformationMessage(
      `Manifest Lens: ${text}`,
      ...(vulnerable > 0 ? ["Open Problems"] : [])
    );
    if (choice) {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }
  });
  register("updateDependency", async (argument, version) => {
    const key =
      keyOf(argument) ?? (await pickDependency(["update", "blocked"]));
    if (key) {
      await controller.updateDependency(
        key,
        typeof version === "string" ? version : undefined,
        { install: false }
      );
    }
  });
  register("updateDependencyAndInstall", async (argument, version) => {
    const key =
      keyOf(argument) ?? (await pickDependency(["update", "blocked"]));
    if (key) {
      await controller.updateDependency(
        key,
        typeof version === "string" ? version : undefined,
        { install: true }
      );
    }
  });
  register("resolveToInstalled", async (argument) => {
    const key =
      keyOf(argument) ??
      (await pickDependency(["update", "up-to-date", "blocked"]));
    if (key) {
      await controller.resolveToInstalled(key);
    }
  });
  register("updateBlockedDependency", async (argument, version) => {
    const key = keyOf(argument) ?? (await pickDependency(["blocked"]));
    if (key) {
      await controller.updateBlocked(
        key,
        typeof version === "string" ? version : undefined
      );
    }
  });
  register("cancel", () => {
    analysis.cancelAll();
    if (!services.runner.cancel()) {
      void vscode.window.showInformationMessage(
        "Manifest Lens: no operation is running. Pending analyses were cancelled."
      );
    }
  });
  register("showDiagnostics", () => {
    const lines = [
      "=== Manifest Lens diagnostics ===",
      `workspace trusted: ${vscode.workspace.isTrusted}`,
      `manifests indexed: ${index.all().length}`,
      ...services.cacheReport(),
      ...analysis.states().map((state) => {
        const summary = state.analysis?.summary;
        return `${state.uri}: ${state.status}${state.stale ? " (stale)" : ""}${summary ? ` — ${summary.updates} updates, ${summary.blocked} blocked, ${summary.vulnerable} vulnerable, ${summary.errors} errors` : ""}${state.error ? ` — ${state.error.message}` : ""}`;
      }),
    ];
    for (const line of lines) {
      logger.report(line);
    }
    logger.show();
  });
  register("clearCache", () => {
    services.clearCaches();
    analysis.requestAll({ immediate: true });
    void vscode.window.showInformationMessage("Manifest Lens: caches cleared.");
  });
  register("showAdvisories", async (argument) => {
    const item = analysis.findItem(keyOf(argument) ?? "");
    if (!item) {
      return;
    }
    const advisories = currentAdvisories(item).toSorted((a, b) =>
      compareSeverity(a.advisory.severity, b.advisory.severity)
    );
    const picked = await vscode.window.showQuickPick(
      advisories.map((match) => ({
        description: match.advisory.severity,
        detail: `${clip(match.advisory.summary, 200)} — ${match.fixedVersions[0] ? `fixed in ${match.fixedVersions[0]}` : "no fix available"}`,
        label: match.advisory.id,
        url: match.advisory.references[0]?.url,
      })),
      {
        placeHolder: `${item.declaration.name}@${item.currentVersion ?? "?"}: select an advisory to open its reference`,
      }
    );
    if (picked?.url && isWebUrl(picked.url)) {
      await vscode.env.openExternal(vscode.Uri.parse(picked.url));
    }
  });
  register("showConflicts", async (argument, version) => {
    const item = analysis.findItem(keyOf(argument) ?? "");
    const target =
      typeof version === "string" ? version : item?.selection?.target?.version;
    const peer = item && target ? item.peer[target] : undefined;
    if (!(item && peer)) {
      return;
    }
    await vscode.window.showQuickPick(
      peer.conflicts.map((conflict) => ({
        description: conflict.confidence,
        detail: conflict.resolution
          ? `Upgrading ${conflict.resolution.package} to ${conflict.resolution.version} relaxes this requirement.`
          : conflict.note,
        label: `${conflict.blocker} ${conflict.requiredRange}`,
      })),
      {
        placeHolder: `${item.declaration.name}@${target}: peer dependency conflicts`,
      }
    );
  });
  register("updateSection", async (first, second) => {
    if (typeof first === "string" && typeof second === "string") {
      await controller.bulk({ scope: "all", sectionId: second, uris: [first] });
      return;
    }
    const sectionId = sectionIdOf(first);
    const uri = uriOf(first);
    if (sectionId && uri) {
      await controller.bulk({ scope: "all", sectionId, uris: [uri] });
    }
  });
  register("openPackagePage", async (argument) => {
    const key = keyOf(argument);
    let url: string | undefined;
    if (key) {
      url = analysis.findItem(key)?.links.npm;
    } else if (typeof argument === "string") {
      url = argument;
    }
    if (url && isWebUrl(url)) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  });
  register("openAdvisory", async (argument) => {
    if (typeof argument === "string" && isWebUrl(argument)) {
      await vscode.env.openExternal(vscode.Uri.parse(argument));
    }
  });
  register("revealDeclaration", async (argument) => {
    const key = keyOf(argument);
    const item = key ? analysis.findItem(key) : undefined;
    if (item) {
      const uri = item.catalogSource?.manifestUri ?? item.manifestUri;
      const declaration = item.catalogSource?.declaration ?? item.declaration;
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(uri)
      );
      const range = new vscode.Range(
        document.positionAt(declaration.nameSpan.start),
        document.positionAt(declaration.valueSpan.end)
      );
      await vscode.window.showTextDocument(document, {
        preserveFocus: false,
        selection: range,
      });
      return;
    }
    const uri = uriOf(argument);
    if (!uri) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(uri)
    );
    let selection: vscode.Range | undefined;
    const sectionId =
      typeof argument === "object" &&
      argument !== null &&
      "sectionId" in argument
        ? argument.sectionId
        : undefined;
    const section = analysis
      .get(uri)
      ?.parsed?.sections.find((candidate) => candidate.id === sectionId);
    if (section) {
      selection = new vscode.Range(
        document.positionAt(section.keySpan.start),
        document.positionAt(section.keySpan.end)
      );
    }
    await vscode.window.showTextDocument(
      document,
      selection ? { selection } : {}
    );
  });

  const setFilters = (filters: DashboardFilters): void => {
    dashboard.setFilters(filters);
  };
  register("dashboard.filterSeverity", async () => {
    const current = dashboard.activeFilters;
    const picked = await vscode.window.showQuickPick(
      SEVERITY_CHOICES.map((severity) => ({
        label: severity,
        picked: current.severities.includes(severity),
      })),
      {
        canPickMany: true,
        placeHolder: "Show only updates of these severities (none = all)",
      }
    );
    if (picked) {
      setFilters({
        ...current,
        severities: picked
          .map((item) => item.label)
          .filter((label): label is (typeof SEVERITY_CHOICES)[number] =>
            SEVERITY_CHOICES.some((severity) => severity === label)
          ),
      });
    }
  });
  register("dashboard.filterVulnerable", () => {
    setFilters({
      ...dashboard.activeFilters,
      vulnerableOnly: !dashboard.activeFilters.vulnerableOnly,
    });
  });
  register("dashboard.filterBlocked", () => {
    setFilters({
      ...dashboard.activeFilters,
      blockedOnly: !dashboard.activeFilters.blockedOnly,
    });
  });
  register("dashboard.clearFilters", () => {
    setFilters(NO_FILTERS);
    dashboard.selectManifest(undefined);
  });
  register("dashboard.selectManifest", async () => {
    const manifests = index.all();
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(list-flat) All manifests", uri: undefined },
        ...manifests.map((manifest) => ({
          description: manifest.parsed.name,
          label: vscode.workspace.asRelativePath(
            vscode.Uri.parse(manifest.uri)
          ),
          uri: manifest.uri,
        })),
      ],
      { placeHolder: "Select the manifest to show in the dashboard" }
    );
    if (picked) {
      dashboard.selectManifest(picked.uri);
      if (picked.uri) {
        analysis.request(picked.uri, { immediate: true });
      }
    }
  });
}
