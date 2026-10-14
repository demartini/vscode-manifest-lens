import * as vscode from "vscode";

import { ManifestAnalyzer } from "./application/analyze-manifest/analyze-manifest";
import { UpdateExecutor } from "./application/update-dependency/update-executor";
import {
  CONFIG_SECTION,
  affectsConfiguration,
  readConfiguration,
} from "./config/configuration";
import type { ManifestLensConfig } from "./config/configuration-schema";
import { manifestFormatOf } from "./domain/manifest/parse";
import { NpmDownloadsClient } from "./infrastructure/downloads/npm-downloads-client";
import { nodeFileProbe } from "./infrastructure/filesystem/node-file-probe";
import { HttpClient } from "./infrastructure/http/http-client";
import { NodeInstalledPackages } from "./infrastructure/installed-packages/node-installed-packages";
import { OutputChannelLogger } from "./infrastructure/logging/output-channel-logger";
import { OSV_BASE_URL, OsvClient } from "./infrastructure/osv/osv-client";
import { Installer } from "./infrastructure/package-manager/installer";
import { readManagerReleaseAge } from "./infrastructure/package-manager/release-age-reader";
import { NpmRegistryClient } from "./infrastructure/registry/npm-registry-client";
import { OperationRunner } from "./vscode/commands/operation-runner";
import { registerCommands } from "./vscode/commands/register-commands";
import { UpdateController } from "./vscode/commands/update-controller";
import { DependencyCodeActionProvider } from "./vscode/providers/code-action-provider";
import { DependencyCodeLensProvider } from "./vscode/providers/codelens-provider";
import { DecorationController } from "./vscode/providers/decoration-controller";
import { DiagnosticsController } from "./vscode/providers/diagnostics-controller";
import { DependencyHoverProvider } from "./vscode/providers/hover-provider";
import { StatusBarController } from "./vscode/providers/status-bar-controller";
import { UiState } from "./vscode/providers/ui-state";
import { AnalysisService } from "./vscode/services/analysis-service";
import { DocumentViews } from "./vscode/services/document-view";
import { VsCodeManifestEditor } from "./vscode/services/manifest-editor";
import { PackageManagerResolver } from "./vscode/services/package-manager-resolver";
import { SUPPORTED_SELECTOR, isManifestDocument } from "./vscode/services/uri";
import { WorkspaceIndex } from "./vscode/services/workspace-index";
import { DashboardProvider } from "./vscode/tree-view/dashboard-provider";

const USER_AGENT = "manifest-lens-vscode";
const REGISTRY_MAX_BYTES = 64 * 1024 * 1024;
const OSV_MAX_BYTES = 8 * 1024 * 1024;
const SMALL_MAX_BYTES = 1024 * 1024;
const OSV_CACHE_MS = 15 * 60 * 1000;
// Lockfiles decide the package manager; its configuration files decide the minimum release age.
const LOCKFILES =
  "**/{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,bunfig.toml,.npmrc}";

/** Handles for integration tests; this is not a public, supported API. */
export interface ManifestLensTestApi {
  readonly analysis: AnalysisService;
  readonly dashboard: DashboardProvider;
  readonly decorations: DecorationController;
  readonly index: WorkspaceIndex;
  readonly ui: UiState;
  readonly config: () => ManifestLensConfig;
  readonly clearCaches: () => void;
}

export function activate(
  context: vscode.ExtensionContext
): ManifestLensTestApi {
  const { subscriptions } = context;
  const track = <T extends vscode.Disposable>(disposable: T): T => {
    subscriptions.push(disposable);
    return disposable;
  };

  let config = readConfiguration();
  const logger = track(new OutputChannelLogger());
  logger.setLevel(config.logging.level);
  const getConfig = (): ManifestLensConfig => config;
  const now = (): number => Date.now();

  const httpFor = (maxResponseBytes: number): HttpClient =>
    new HttpClient({
      maxResponseBytes,
      retries: 2,
      timeoutMs: () => config.analysis.timeout,
      userAgent: USER_AGENT,
    });
  const registry = new NpmRegistryClient({
    http: httpFor(REGISTRY_MAX_BYTES),
    now,
    settings: () => ({
      cacheTtlMs: config.cacheTimeout,
      registryUrl: config.registry,
    }),
  });
  const osv = new OsvClient({
    http: httpFor(OSV_MAX_BYTES),
    now,
    settings: () => ({
      // Integration tests point the advisory client at a local server.
      baseUrl:
        context.extensionMode === vscode.ExtensionMode.Test
          ? (process.env.MANIFEST_LENS_OSV_URL ?? OSV_BASE_URL)
          : OSV_BASE_URL,
      cacheTtlMs: OSV_CACHE_MS,
      concurrency: config.analysis.concurrency,
    }),
  });
  const downloads = new NpmDownloadsClient(httpFor(SMALL_MAX_BYTES));
  const installedPackages = new NodeInstalledPackages();
  const installer = new Installer();

  const analyzer = new ManifestAnalyzer({
    advisories: osv,
    clock: { now },
    installed: installedPackages,
    logger,
    registry,
  });
  const index = track(new WorkspaceIndex(logger));
  const resolver = track(
    new PackageManagerResolver(() => config.packageManager)
  );
  const analysis = track(
    new AnalysisService({
      analyzer,
      config: getConfig,
      index,
      logger,
      managerReleaseAge: async (manifestUri) =>
        await readManagerReleaseAge(
          nodeFileProbe,
          await resolver.resolve(manifestUri)
        ),
      now,
    })
  );
  const views = new DocumentViews(analysis);
  const ui = track(new UiState(config.codeLens.showOnStartup));
  const runner = track(new OperationRunner());
  const editor = new VsCodeManifestEditor();

  const executor = new UpdateExecutor({
    detect: async (dir) => await resolver.resolveForDir(dir),
    editor,
    install: async (request) => await installer.install(request),
    logger,
  });
  const controller = new UpdateController({
    analysis,
    config: getConfig,
    editor,
    executor,
    installer,
    logger,
    onInstalled: () => {
      installedPackages.invalidate();
      resolver.invalidate();
      analysis.requestAll({ immediate: true });
    },
    resolver,
    runner,
  });

  const clearCaches = (): void => {
    registry.clearCache();
    osv.clearCache();
    downloads.clearCache();
    installedPackages.invalidate();
    resolver.invalidate();
  };

  const codeLens = track(
    new DependencyCodeLensProvider({ analysis, config: getConfig, ui, views })
  );
  const decorations = track(
    new DecorationController({ analysis, config: getConfig, now, views })
  );
  const diagnostics = track(
    new DiagnosticsController({ analysis, config: getConfig, views })
  );
  track(new StatusBarController({ analysis, packageManager: resolver }));
  const dashboard = track(
    new DashboardProvider({
      analysis,
      config: getConfig,
      now,
      workspaceManifests: () => index.all().map((entry) => entry.uri),
    })
  );

  track(
    vscode.languages.registerCodeLensProvider(SUPPORTED_SELECTOR, codeLens)
  );
  track(
    vscode.languages.registerCodeActionsProvider(
      SUPPORTED_SELECTOR,
      new DependencyCodeActionProvider({ config: getConfig, views }),
      DependencyCodeActionProvider.metadata
    )
  );
  track(
    vscode.languages.registerHoverProvider(
      SUPPORTED_SELECTOR,
      new DependencyHoverProvider({ config: getConfig, downloads, now, views })
    )
  );
  const treeView = track(
    vscode.window.createTreeView("manifestLens.dashboard", {
      showCollapseAll: true,
      treeDataProvider: dashboard,
    })
  );
  const updateTreeMessage = (): void => {
    treeView.message = dashboard.describeFilters();
  };
  track(dashboard.onDidChangeTreeData(updateTreeMessage));
  track(
    treeView.onDidChangeVisibility((event) => {
      if (event.visible && config.workspace.enabled) {
        void analysis.analyzeWorkspace();
      }
    })
  );

  registerCommands(context, {
    analysis,
    cacheReport: () => [
      `registry cache entries: ${registry.cacheSize}`,
      `registry: ${config.registry}`,
      `security checks: ${config.security.enabled ? "enabled (api.osv.dev)" : "disabled"}`,
      `peer analysis: ${config.peerDependencies.enabled ? "enabled" : "disabled"}`,
      `update policy: ${config.updatePolicy}`,
    ],
    clearCaches,
    config: getConfig,
    controller,
    dashboard,
    index,
    logger,
    resolver,
    runner,
    ui,
  });

  // --- Wiring: documents, editors, files, configuration, trust -------------

  const requestIfManifest = (document: vscode.TextDocument): void => {
    if (isManifestDocument(document)) {
      void index.refreshOne(document.uri.toString()).then(() => {
        analysis.request(document.uri.toString());
      });
    }
  };
  const visibleManifests = (): vscode.TextDocument[] =>
    vscode.window.visibleTextEditors
      .map((e) => e.document)
      .filter(isManifestDocument);

  for (const document of visibleManifests()) {
    requestIfManifest(document);
  }
  track(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const document of visibleManifests()) {
        if (!analysis.get(document.uri.toString())) {
          requestIfManifest(document);
        }
      }
    })
  );
  track(vscode.window.onDidChangeActiveTextEditor(() => void ui.publish()));
  track(vscode.workspace.onDidOpenTextDocument(requestIfManifest));
  track(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        !isManifestDocument(event.document) ||
        event.contentChanges.length === 0
      ) {
        return;
      }
      const uri = event.document.uri.toString();
      void index.refreshOne(uri).then(() => {
        analysis.request(uri);
        if (manifestFormatOf(uri) === "pnpm-workspace") {
          analysis.requestAll();
        }
      });
    })
  );
  track(
    vscode.workspace.onDidCloseTextDocument((document) => {
      views.forget(document.uri.toString());
    })
  );
  track(
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const file of event.files) {
        analysis.forget(file.toString());
        index.remove(file.toString());
      }
    })
  );
  track(
    index.onDidChange(() => {
      dashboard.refresh();
    })
  );

  const lockfileWatcher = track(
    vscode.workspace.createFileSystemWatcher(LOCKFILES)
  );
  let lockfileTimer: NodeJS.Timeout | undefined;
  const onLockfileChange = (): void => {
    if (lockfileTimer) {
      clearTimeout(lockfileTimer);
    }
    lockfileTimer = setTimeout(() => {
      installedPackages.invalidate();
      resolver.invalidate();
      analysis.requestAll();
    }, 500);
  };
  track(lockfileWatcher.onDidChange(onLockfileChange));
  track(lockfileWatcher.onDidCreate(onLockfileChange));
  track(lockfileWatcher.onDidDelete(onLockfileChange));
  track({ dispose: () => lockfileTimer && clearTimeout(lockfileTimer) });

  const applyConfiguration = (): void => {
    config = readConfiguration();
    logger.setLevel(config.logging.level);
    void ui.publish(config.prerelease.enabled, runner.current !== undefined);
    analysis.requestAll({ immediate: true });
    codeLens.refresh();
    decorations.schedule();
    diagnostics.refreshAll();
    updateTreeMessage();
    dashboard.refresh();
  };
  track(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsConfiguration(event)) {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.packageManager`)) {
          resolver.invalidate();
        }
        applyConfiguration();
      }
    })
  );
  track(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      resolver.invalidate();
      applyConfiguration();
    })
  );
  track(vscode.workspace.onDidChangeWorkspaceFolders(() => void index.scan()));
  track(
    runner.onDidChangeBusy(
      (busy) => void ui.publish(config.prerelease.enabled, busy)
    )
  );
  track(
    analysis.onDidChangeBusy((busy) => {
      if (!busy) {
        decorations.schedule();
      }
    })
  );

  void ui.publish(config.prerelease.enabled, false);
  if (config.workspace.enabled) {
    void index.scan();
  }
  logger.info("Manifest Lens activated.");

  return {
    analysis,
    clearCaches,
    config: getConfig,
    dashboard,
    decorations,
    index,
    ui,
  };
}

export function deactivate(): void {
  // Every resource is registered in `context.subscriptions` and disposed by VS Code.
}
