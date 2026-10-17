import * as assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import type { ManifestLensTestApi } from "../../src/extension";
import {
  DEFAULT_PUBLISHED_AT,
  type FakeServer,
  type TestCase,
  createCase,
  getApi,
  installFakePackageManager,
  lensTitles,
  openText,
  resetConfig,
  setConfig,
  sleep,
  startOsv,
  startRegistry,
  waitFor,
  waitForAnalysis,
} from "./support";

const PACKAGES = {
  alpha: {
    versions: {
      "1.0.0": { license: "MIT" },
      "1.1.0": { license: "MIT" },
      "2.0.0": { engines: { node: ">=22" }, license: "BUSL-1.1" },
    },
  },
  beta: { versions: { "1.0.0": {} } },
  gamma: { versions: { "1.0.0": {}, "2.0.0": {} } },
  vite: { versions: { "6.0.0": {}, "7.0.0": {} } },
  "vite-plugin-x": {
    versions: {
      "1.0.0": { peerDependencies: { vite: "^6.0.0" } },
      "2.0.0": { peerDependencies: { vite: "^6.0.0 || ^7.0.0" } },
    },
  },
  vuln: { versions: { "1.0.0": {}, "1.1.0": {} } },
};

const OSV = [
  { fixed: "1.1.0", id: "GHSA-TEST-0001", introduced: "0", package: "vuln" },
  { id: "GHSA-TEST-0002", introduced: "2.0.0", package: "gamma" },
];

const MANIFEST = {
  dependencies: {
    alpha: "^1.0.0",
    beta: "^1.0.0",
    gamma: "^1.0.0",
    vuln: "^1.0.0",
  },
  devDependencies: { vite: "^6.0.0", "vite-plugin-x": "^1.0.0" },
};

interface Stubs {
  warnings: { message: string; detail?: string }[];
  restore(): void;
}

const stubWarnings = (
  choose: (message: string, detail: string | undefined) => string | undefined
): Stubs => {
  const warnings: Stubs["warnings"] = [];
  const original = vscode.window.showWarningMessage;
  Reflect.set(
    vscode.window,
    "showWarningMessage",
    async (message: string, ...rest: unknown[]) => {
      const options =
        typeof rest[0] === "object" && rest[0] !== null
          ? (rest[0] as { detail?: string })
          : undefined;
      warnings.push({
        message,
        ...(options?.detail === undefined ? {} : { detail: options.detail }),
      });
      return choose(message, options?.detail);
    }
  );
  return {
    restore: () => Reflect.set(vscode.window, "showWarningMessage", original),
    warnings,
  };
};

describe("editor experience", function editorExperience() {
  this.timeout(90_000);

  let api: ManifestLensTestApi;
  let registry: FakeServer;
  let osv: FakeServer;
  let testCase: TestCase | undefined;
  let restorePath: (() => void) | undefined;
  const marker = join(tmpdir(), `manifest-lens-marker-${process.pid}.log`);

  before(async () => {
    api = await getApi();
    registry = await startRegistry(PACKAGES);
    osv = await startOsv(OSV);
    process.env.MANIFEST_LENS_OSV_URL = osv.url;
    await setConfig("registry", registry.url);
    restorePath = await installFakePackageManager(
      join(tmpdir(), `manifest-lens-bin-${process.pid}`),
      marker
    );
  });

  after(async () => {
    restorePath?.();
    delete process.env.MANIFEST_LENS_OSV_URL;
    await resetConfig([
      "registry",
      "codeLens.enabled",
      "codeLens.showUpToDate",
      "minimumReleaseAge",
      "security.enabled",
    ]);
    await registry.close();
    await osv.close();
  });

  beforeEach(async () => {
    api.clearCaches();
    registry.delayMs = 0;
    registry.publishedAt = DEFAULT_PUBLISHED_AT;
    registry.failing.clear();
    await resetConfig([
      "codeLens.enabled",
      "codeLens.showUpToDate",
      "minimumReleaseAge",
      "security.enabled",
    ]);
    api.ui.setSuggestionsVisible(true);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await testCase?.cleanup();
    testCase = undefined;
  });

  const prepare = async (
    name: string,
    manifest: object = MANIFEST
  ): Promise<{ uri: vscode.Uri; document: vscode.TextDocument }> => {
    testCase = await createCase(name);
    await testCase.write("package.json", manifest);
    await testCase.write("package-lock.json", "{}");
    for (const [pkg, version] of [
      ["alpha", "1.0.0"],
      ["beta", "1.0.0"],
      ["gamma", "1.0.0"],
      ["vuln", "1.0.0"],
      ["vite", "6.0.0"],
    ] as const) {
      await testCase.install(pkg, version);
    }
    await testCase.install("vite-plugin-x", "1.0.0", { vite: "^6.0.0" });
    const uri = testCase.uri();
    const document = await openText(uri);
    await waitForAnalysis(api, uri);
    return { document, uri };
  };

  const keyOf = (uri: vscode.Uri, name: string): string => {
    const item = api.analysis
      .get(uri.toString())
      ?.analysis?.items.find((entry) => entry.declaration.name === name);
    assert.ok(item, `${name} should have been analyzed`);
    return item.key;
  };

  it("shows actionable CodeLens entries and hides up-to-date dependencies", async () => {
    const { document, uri } = await prepare("lenses");
    const titles = await lensTitles(uri);
    assert.ok(titles.includes("Update to 2.0.0"), titles.join(" | "));
    assert.ok(titles.includes("Install Update"));
    assert.ok(titles.includes("7.0.0 blocked by 1 dependency"));
    assert.ok(titles.includes("Install Blocked Update"));
    assert.ok(titles.some((title) => /advisory/u.test(title)));
    assert.ok(
      titles.some((title) => /updates? available/u.test(title)),
      "section summary lens"
    );
    const betaLine = document.positionAt(
      document.getText().indexOf('"beta"')
    ).line;
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri
    );
    assert.equal(
      lenses.filter(
        (lens) =>
          lens.range.start.line === betaLine &&
          lens.command?.title.startsWith("Update")
      ).length,
      0
    );
  });

  it("honours codeLens settings and the toolbar toggle", async () => {
    const { uri } = await prepare("toggles");
    assert.ok((await lensTitles(uri)).length > 0);
    await vscode.commands.executeCommand("manifestLens.hideSuggestions");
    assert.deepEqual(await lensTitles(uri), []);
    await vscode.commands.executeCommand("manifestLens.showSuggestions");
    assert.ok((await lensTitles(uri)).length > 0);
    await setConfig("codeLens.enabled", false);
    await waitFor(
      async () => ((await lensTitles(uri)).length === 0 ? true : undefined),
      "lenses to disappear"
    );
    await setConfig("codeLens.enabled", true);
    await setConfig("codeLens.showUpToDate", true);
    await waitFor(
      async () =>
        (await lensTitles(uri)).includes("Up to date") ? true : undefined,
      "up-to-date lens"
    );
  });

  it("holds back freshly published versions when a minimum release age is set", async () => {
    registry.publishedAt = new Date().toISOString();
    // A background analysis may already have cached the previous publication date.
    api.clearCaches();
    const { uri } = await prepare("fresh");
    const selectionOf = () =>
      api.analysis
        .get(uri.toString())
        ?.analysis?.items.find((item) => item.declaration.name === "alpha")
        ?.selection;
    assert.ok(selectionOf()?.target, "alpha has an update before the limit");
    await setConfig("minimumReleaseAge", 1440);
    await waitFor(() => {
      const selection = selectionOf();
      return selection?.target === undefined && selection?.heldBack.length
        ? true
        : undefined;
    }, "the new versions to be held back");
  });

  it("holds back versions the package manager's own minimum release age would refuse", async () => {
    registry.publishedAt = new Date().toISOString();
    api.clearCaches();
    const { uri } = await prepare("npmrc-age");
    const selectionOf = () =>
      api.analysis
        .get(uri.toString())
        ?.analysis?.items.find((item) => item.declaration.name === "alpha")
        ?.selection;
    assert.ok(selectionOf()?.target, "alpha has an update before the policy");
    // The test project has a package-lock.json, so npm is the detected manager.
    await testCase?.write(".npmrc", "min-release-age=1\n");
    await waitFor(() => {
      const selection = selectionOf();
      return selection?.target === undefined && selection?.heldBack.length
        ? true
        : undefined;
    }, "the .npmrc policy to hold the new versions back");
  });

  it("shows the license, a license change and a Node mismatch in the hover", async () => {
    const { document, uri } = await prepare("hover-details", {
      ...MANIFEST,
      engines: { node: ">=18" },
    });
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      document.positionAt(document.getText().indexOf('"alpha"') + 2)
    );
    const text = hovers
      .flatMap((hover) =>
        hover.contents.map((content) =>
          typeof content === "string" ? content : content.value
        )
      )
      .join("\n");
    assert.match(text, /License:\*\* `MIT`/u);
    assert.match(
      text,
      /License changes in `2\.0\.0`:\*\* `MIT` → `BUSL-1\.1`/u
    );
    assert.match(
      text,
      /`2\.0\.0` requires Node `>=22`; this project declares `>=18`/u
    );
    assert.match(
      text,
      /\[Versions\]\(https:\/\/www\.npmjs\.com\/package\/alpha\?activeTab=versions\)/u
    );
  });

  it("offers update quick fixes on a dependency line and applies one", async () => {
    const { document, uri } = await prepare("code-actions");
    const quickFixesAt = async (needle: string) => {
      const position = document.positionAt(
        document.getText().indexOf(needle) + 2
      );
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        uri,
        new vscode.Range(position, position),
        vscode.CodeActionKind.QuickFix.value
      );
      return actions.filter((action) => action.title.startsWith("Update "));
    };
    const alpha = await quickFixesAt('"alpha"');
    assert.deepEqual(
      alpha.map((action) => action.title),
      ["Update alpha to 2.0.0", "Update alpha to 2.0.0 and install"]
    );
    assert.equal(alpha[0]?.isPreferred, true);
    assert.equal(alpha[1]?.isPreferred, false);
    assert.deepEqual(await quickFixesAt('"beta"'), [], "beta is up to date");
    assert.deepEqual(await quickFixesAt('"dependencies"'), []);
    const command = alpha[0]?.command;
    assert.ok(command);
    await vscode.commands.executeCommand(
      command.command,
      ...(command.arguments ?? [])
    );
    await waitFor(
      () =>
        document.getText().includes('"alpha": "^2.0.0"') ? true : undefined,
      "the quick fix to update the manifest"
    );
    assert.equal(document.isDirty, false, "the manifest is saved");
  });

  it("holds back versions Yarn's own npmMinimalAgeGate would refuse", async () => {
    registry.publishedAt = new Date().toISOString();
    api.clearCaches();
    const { uri } = await prepare("yarnrc-age");
    const selectionOf = () =>
      api.analysis
        .get(uri.toString())
        ?.analysis?.items.find((item) => item.declaration.name === "alpha")
        ?.selection;
    assert.ok(selectionOf()?.target, "alpha has an update before the policy");
    // A .yarnrc.yml selects Yarn even though the test project also has a package-lock.json.
    await testCase?.write(".yarnrc.yml", "npmMinimalAgeGate: 1d\n");
    await waitFor(() => {
      const selection = selectionOf();
      return selection?.target === undefined && selection?.heldBack.length
        ? true
        : undefined;
    }, "the .yarnrc.yml policy to hold the new versions back");
  });

  it("updates a complex range by widening it just enough", async () => {
    const { document, uri } = await prepare("complex-range", {
      dependencies: { alpha: ">=1.0.0 <2.0.0" },
    });
    await vscode.commands.executeCommand(
      "manifestLens.updateDependency",
      keyOf(uri, "alpha"),
      "2.0.0"
    );
    await waitFor(
      () =>
        document.getText().includes('"alpha": ">=1.0.0 <3.0.0"')
          ? true
          : undefined,
      "the comparator range to be widened"
    );
    assert.equal(document.isDirty, false, "the manifest is saved");
  });

  it("never calls a declared version that is not published up to date", async () => {
    await setConfig("codeLens.showUpToDate", true);
    const { document, uri } = await prepare("unpublished", {
      dependencies: { alpha: "^2.5.0", beta: "^1.0.0" },
    });
    const alpha = api.analysis
      .get(uri.toString())
      ?.analysis?.items.find((item) => item.declaration.name === "alpha");
    assert.equal(alpha?.status, "unpublished");
    assert.equal(alpha?.selection?.unpublished?.reason, "ahead-of-latest");
    const titles = await lensTitles(uri);
    // beta is genuinely current and gets the lens; alpha does not.
    assert.equal(titles.filter((title) => title === "Up to date").length, 1);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      document.positionAt(document.getText().indexOf('"alpha"') + 2)
    );
    const text = hovers
      .flatMap((hover) =>
        hover.contents.map((content) =>
          typeof content === "string" ? content : content.value
        )
      )
      .join("\n");
    assert.match(
      text,
      /Not published:\*\* `2\.5\.0` is newer than the latest release `2\.0\.0`/u
    );
  });

  it("describes a dependency on hover with versions, advisories and blockers", async () => {
    const { document, uri } = await prepare("hover");
    const position = document.positionAt(
      document.getText().indexOf('"vuln"') + 2
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      position
    );
    const text = hovers
      .flatMap((hover) =>
        hover.contents.map((content) =>
          typeof content === "string" ? content : content.value
        )
      )
      .join("\n");
    assert.match(text, /vuln/u);
    assert.match(text, /GHSA/u);
    assert.match(text, /Fixed in `1\.1\.0`/u);
    const vitePosition = document.positionAt(
      document.getText().indexOf('"vite"') + 2
    );
    const viteHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      vitePosition
    );
    const viteText = viteHovers
      .flatMap((hover) =>
        hover.contents.map((content) =>
          typeof content === "string" ? content : content.value
        )
      )
      .join("\n");
    assert.match(viteText, /Blocked by 1 dependency/u);
    assert.match(viteText, /vite\\-plugin\\-x/u);
  });

  it("publishes advisories to the Problems panel and clears them when security is disabled", async () => {
    const { uri } = await prepare("diagnostics");
    const diagnostics = await waitFor(() => {
      const found = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.source === "Manifest Lens");
      return found.length > 0 ? found : undefined;
    }, "diagnostics");
    assert.equal(diagnostics.length, 1, "one diagnostic per distinct advisory");
    assert.match(diagnostics[0]?.message ?? "", /GHSA-TEST-0001/u);
    assert.equal(diagnostics[0]?.severity, vscode.DiagnosticSeverity.Error);
    await setConfig("security.enabled", false);
    await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(uri)
          .filter((d) => d.source === "Manifest Lens").length === 0
          ? true
          : undefined,
      "diagnostics to clear"
    );
  });

  it("updates a dependency without installing, preserving the operator", async () => {
    const { document, uri } = await prepare("update");
    await vscode.commands.executeCommand(
      "manifestLens.updateDependency",
      keyOf(uri, "alpha"),
      "2.0.0"
    );
    await waitFor(
      () =>
        document.getText().includes('"alpha": "^2.0.0"') ? true : undefined,
      "manifest update"
    );
    assert.equal(document.isDirty, false, "the manifest is saved");
    await sleep(500);
    assert.equal(
      existsSync(marker) &&
        readFileSync(marker, "utf-8").includes("npm install"),
      false,
      "nothing was installed"
    );
    const state = await waitForAnalysis(
      api,
      uri,
      (s) =>
        s.analysis?.items.find((i) => i.declaration.name === "alpha")
          ?.declaration.specifier === "^2.0.0"
    );
    assert.equal(
      state.analysis?.items.find((i) => i.declaration.name === "alpha")?.status,
      "up-to-date"
    );
  });

  it("installs with the detected package manager from the lockfile root", async () => {
    const { document, uri } = await prepare("install");
    await vscode.commands.executeCommand(
      "manifestLens.updateDependencyAndInstall",
      keyOf(uri, "alpha"),
      "1.1.0"
    );
    await waitFor(
      () =>
        document.getText().includes('"alpha": "^1.1.0"') ? true : undefined,
      "manifest update"
    );
    const record = await waitFor(
      () => (existsSync(marker) ? readFileSync(marker, "utf-8") : undefined),
      "install marker"
    );
    assert.match(record, /npm install/u);
    assert.ok(record.includes(testCase?.dir ?? "?"), "ran in the project root");
  });

  it("requires explicit confirmation before applying a blocked update", async () => {
    const { document, uri } = await prepare("blocked");
    const declined = stubWarnings(() => undefined);
    try {
      await vscode.commands.executeCommand(
        "manifestLens.updateBlockedDependency",
        keyOf(uri, "vite"),
        "7.0.0"
      );
    } finally {
      declined.restore();
    }
    assert.match(
      declined.warnings[0]?.message ?? "",
      /conflicts with peer dependency/u
    );
    assert.match(declined.warnings[0]?.detail ?? "", /vite-plugin-x/u);
    assert.ok(
      document.getText().includes('"vite": "^6.0.0"'),
      "declining leaves the manifest untouched"
    );

    const accepted = stubWarnings((message) =>
      /conflicts/u.test(message) ? "Update Only" : undefined
    );
    try {
      await vscode.commands.executeCommand(
        "manifestLens.updateBlockedDependency",
        keyOf(uri, "vite"),
        "7.0.0"
      );
      await waitFor(
        () =>
          document.getText().includes('"vite": "^7.0.0"') ? true : undefined,
        "blocked update"
      );
    } finally {
      accepted.restore();
    }
  });

  it("warns before applying a version with known advisories", async () => {
    const { document, uri } = await prepare("advisory");
    const declined = stubWarnings(() => undefined);
    try {
      await vscode.commands.executeCommand(
        "manifestLens.updateDependency",
        keyOf(uri, "gamma"),
        "2.0.0"
      );
    } finally {
      declined.restore();
    }
    assert.match(declined.warnings[0]?.detail ?? "", /GHSA-TEST-0002/u);
    assert.ok(document.getText().includes('"gamma": "^1.0.0"'));
    const accepted = stubWarnings(() => "Update Anyway");
    try {
      await vscode.commands.executeCommand(
        "manifestLens.updateDependency",
        keyOf(uri, "gamma"),
        "2.0.0"
      );
      await waitFor(
        () =>
          document.getText().includes('"gamma": "^2.0.0"') ? true : undefined,
        "update after confirmation"
      );
    } finally {
      accepted.restore();
    }
  });

  it("rewrites to the installed version without installing", async () => {
    testCase = await createCase("resolved");
    await testCase.write("package.json", { dependencies: { alpha: "^1.0.0" } });
    await testCase.install("alpha", "1.1.0");
    const uri = testCase.uri();
    const document = await openText(uri);
    await waitForAnalysis(api, uri);
    assert.ok((await lensTitles(uri)).includes("Resolved as 1.1.0"));
    await vscode.commands.executeCommand(
      "manifestLens.resolveToInstalled",
      keyOf(uri, "alpha")
    );
    await waitFor(
      () =>
        document.getText().includes('"alpha": "^1.1.0"') ? true : undefined,
      "resolve"
    );
  });

  it("never reports registry failures as up to date", async () => {
    registry.failing.add("alpha");
    const { uri } = await prepare("offline");
    const alpha = api.analysis
      .get(uri.toString())
      ?.analysis?.items.find((i) => i.declaration.name === "alpha");
    assert.equal(alpha?.status, "error");
    const titles = await lensTitles(uri);
    assert.ok(titles.some((title) => /Registry unavailable/u.test(title)));
    assert.equal(api.analysis.get(uri.toString())?.analysis?.partial, true);
  });

  it("discards analysis results computed for text that has since changed", async () => {
    registry.delayMs = 400;
    testCase = await createCase("stale");
    await testCase.write("package.json", { dependencies: { alpha: "^1.0.0" } });
    const uri = testCase.uri();
    const document = await openText(uri);
    api.analysis.request(uri.toString(), { immediate: true });
    await sleep(100);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), " ");
    await vscode.workspace.applyEdit(edit);
    const state = await waitForAnalysis(
      api,
      uri,
      (s) =>
        s.status === "ready" && s.analysis?.documentVersion === document.version
    );
    assert.equal(state.analysis?.documentVersion, document.version);
  });

  it("re-applies annotations when a manifest is closed and reopened, and keeps diagnostics", async () => {
    const { uri } = await prepare("reopen");
    await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(uri)
          .some((d) => d.source === "Manifest Lens")
          ? true
          : undefined,
      "diagnostics"
    );
    const before = api.decorations.applyCount;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await openText(uri);
    await waitFor(
      () => (api.decorations.applyCount > before ? true : undefined),
      "annotations to be re-applied"
    );
    // A forget + fresh analysis (what a cache refresh does) must not lose the advisories.
    api.analysis.forget(uri.toString());
    api.analysis.request(uri.toString(), { immediate: true });
    await waitForAnalysis(api, uri);
    await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(uri)
          .some((d) => d.source === "Manifest Lens")
          ? true
          : undefined,
      "diagnostics after re-analysis"
    );
  });

  it("sorts dependency sections without touching anything else", async () => {
    testCase = await createCase("sort");
    await testCase.write(
      "package.json",
      '{\n  "name": "x",\n  "dependencies": {\n    "zeta": "1.0.0",\n    "alpha": "1.0.0"\n  }\n}\n'
    );
    const document = await openText(testCase.uri());
    await vscode.commands.executeCommand("manifestLens.sortDependencies");
    await waitFor(
      () =>
        document.getText().indexOf('"alpha"') <
        document.getText().indexOf('"zeta"')
          ? true
          : undefined,
      "sort"
    );
    assert.equal(
      document.getText(),
      '{\n  "name": "x",\n  "dependencies": {\n    "alpha": "1.0.0",\n    "zeta": "1.0.0"\n  }\n}\n'
    );
  });

  it("lists manifests, sections and dependencies in the dashboard", async () => {
    const { uri } = await prepare("dashboard");
    const roots = api.dashboard.getChildren();
    const manifest = roots.find(
      (node) => node.kind === "manifest" && node.uri === uri.toString()
    );
    assert.ok(manifest);
    const sections = api.dashboard.getChildren(manifest);
    assert.deepEqual(
      sections.map((section) => api.dashboard.getTreeItem(section).label),
      ["Dependencies", "Dev Dependencies"]
    );
    const deps = api.dashboard.getChildren(sections[0]);
    const alpha = deps
      .map((node) => api.dashboard.getTreeItem(node))
      .find((item) => item.label === "alpha");
    assert.match(
      `${String(alpha?.description)} ${JSON.stringify(api.analysis.get(uri.toString())?.analysis?.items.find((i) => i.declaration.name === "alpha")?.registry)}`,
      /\^1\.0\.0.*→ 2\.0\.0 \(major\)/u
    );
    assert.equal(alpha?.contextValue, "dependency.updatable");
    const vite = api.dashboard
      .getChildren(sections[1])
      .map((node) => api.dashboard.getTreeItem(node))
      .find((item) => item.label === "vite");
    assert.equal(vite?.contextValue, "dependency.blocked");
    api.dashboard.setFilters({
      blockedOnly: true,
      severities: [],
      updatesOnly: false,
      vulnerableOnly: false,
    });
    const filtered = api.dashboard
      .getChildren(manifest)
      .flatMap((section) => api.dashboard.getChildren(section));
    assert.deepEqual(
      filtered.map((node) => api.dashboard.getTreeItem(node).label),
      ["vite"]
    );
    api.dashboard.setFilters({
      blockedOnly: false,
      severities: [],
      updatesOnly: false,
      vulnerableOnly: false,
    });
  });

  it("links each dependency to the right declaration in a multi-manifest workspace", async () => {
    testCase = await createCase("monorepo");
    await testCase.write("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await testCase.write("packages/a/package.json", {
      dependencies: { alpha: "^1.0.0" },
      name: "@m/a",
    });
    await testCase.write("packages/b/package.json", {
      dependencies: { alpha: "^1.1.0", beta: "^1.0.0" },
      name: "@m/b",
    });
    await api.index.scan();
    const uriB = testCase.uri("packages/b/package.json");
    await api.analysis.analyzeNow(uriB.toString());
    // A newer request can supersede the run above, so wait for a settled result.
    const state = await waitForAnalysis(api, uriB);
    const alphaB = state.analysis?.items.find(
      (i) => i.declaration.name === "alpha"
    );
    assert.ok(alphaB);
    await vscode.commands.executeCommand("manifestLens.revealDeclaration", {
      key: alphaB.key,
      kind: "dependency",
    });
    const editor = await waitFor(
      () =>
        vscode.window.activeTextEditor?.document.uri.fsPath === uriB.fsPath
          ? vscode.window.activeTextEditor
          : undefined,
      "declaration to open"
    );
    assert.equal(
      editor.document
        .lineAt(editor.selection.start.line)
        .text.trim()
        .replace(/,$/u, ""),
      '"alpha": "^1.1.0"'
    );
  });
});
