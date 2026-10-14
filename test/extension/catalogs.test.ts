import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import type { ManifestLensTestApi } from "../../src/extension";
import {
  type FakeServer,
  type TestCase,
  createCase,
  getApi,
  lensTitles,
  openText,
  resetConfig,
  setConfig,
  startOsv,
  startRegistry,
  waitFor,
  waitForAnalysis,
} from "./support";

describe("catalogs", function catalogs() {
  this.timeout(90_000);

  let api: ManifestLensTestApi;
  let registry: FakeServer;
  let osv: FakeServer;
  let testCase: TestCase | undefined;

  before(async () => {
    api = await getApi();
    registry = await startRegistry({
      react: { versions: { "18.2.0": {}, "18.3.1": {}, "19.0.0": {} } },
      zod: { versions: { "3.0.0": {}, "3.5.0": {} } },
    });
    osv = await startOsv([]);
    process.env.MANIFEST_LENS_OSV_URL = osv.url;
    await setConfig("registry", registry.url);
  });

  after(async () => {
    delete process.env.MANIFEST_LENS_OSV_URL;
    await resetConfig(["registry"]);
    await registry.close();
    await osv.close();
  });

  beforeEach(() => {
    api.clearCaches();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await testCase?.cleanup();
    testCase = undefined;
  });

  const item = (uri: vscode.Uri, name: string) => {
    const found = api.analysis
      .get(uri.toString())
      ?.analysis?.items.find((entry) => entry.declaration.name === name);
    assert.ok(found, `${name} should be analyzed in ${uri.fsPath}`);
    return found;
  };

  it("analyzes pnpm-workspace.yaml catalogs and updates them in place, preserving quoting", async () => {
    testCase = await createCase("pnpm-catalog");
    await testCase.write(
      "pnpm-workspace.yaml",
      "packages:\n  - packages/*\ncatalog:\n  react: ^18.2.0\n  zod: '~3.0.0'\n"
    );
    await testCase.write("package.json", { name: "root", private: true });
    const yamlUri = testCase.uri("pnpm-workspace.yaml");
    const document = await openText(yamlUri);
    await waitForAnalysis(api, yamlUri);
    const titles = await lensTitles(yamlUri);
    assert.ok(titles.includes("Update to 19.0.0"), titles.join(" | "));
    assert.ok(titles.includes("Update to 3.5.0"));
    await vscode.commands.executeCommand(
      "manifestLens.updateDependency",
      item(yamlUri, "zod").key,
      "3.5.0"
    );
    await waitFor(
      () => (document.getText().includes("zod: '~3.5.0'") ? true : undefined),
      "single-quoted YAML value to be rewritten in place"
    );
    assert.equal(document.isDirty, false);
    assert.ok(document.getText().includes("react: ^18.2.0"));
  });

  it("resolves catalog: references in package.json and edits the catalog entry", async () => {
    testCase = await createCase("catalog-ref");
    await testCase.write(
      "pnpm-workspace.yaml",
      "packages:\n  - packages/*\ncatalog:\n  react: ^18.2.0\n"
    );
    await testCase.write("package.json", { name: "root", private: true });
    await testCase.write("packages/app/package.json", {
      dependencies: { react: "catalog:" },
      name: "@m/app",
    });
    await api.index.scan();
    const manifestUri = testCase.uri("packages/app/package.json");
    const yamlUri = testCase.uri("pnpm-workspace.yaml");
    const document = await openText(manifestUri);
    await waitForAnalysis(api, manifestUri);
    const react = item(manifestUri, "react");
    assert.equal(react.support.kind, "supported");
    assert.equal(react.catalogSource?.manifestUri, yamlUri.toString());
    assert.equal(react.selection?.target?.version, "19.0.0");
    await vscode.commands.executeCommand(
      "manifestLens.updateDependency",
      react.key,
      "19.0.0"
    );
    const yaml = await vscode.workspace.openTextDocument(yamlUri);
    await waitFor(
      () => (yaml.getText().includes("react: ^19.0.0") ? true : undefined),
      "catalog entry update"
    );
    assert.ok(
      document.getText().includes('"react": "catalog:"'),
      "the reference is left untouched"
    );
  });

  it("supports Bun's workspaces.catalog in package.json", async () => {
    testCase = await createCase("bun-catalog");
    await testCase.write("package.json", {
      name: "root",
      private: true,
      workspaces: {
        catalog: { react: "^18.2.0" },
        catalogs: { legacy: { zod: "~3.0.0" } },
        packages: ["packages/*"],
      },
    });
    const uri = testCase.uri();
    const document = await openText(uri);
    await waitForAnalysis(api, uri);
    const react = item(uri, "react");
    assert.equal(react.declaration.section, "catalog");
    assert.equal(react.selection?.target?.version, "19.0.0");
    const zod = item(uri, "zod");
    assert.equal(zod.declaration.catalog, "legacy");
    const titles = await lensTitles(uri);
    assert.ok(titles.includes("Update to 19.0.0"), titles.join(" | "));
    await vscode.commands.executeCommand(
      "manifestLens.updateDependency",
      react.key,
      "19.0.0"
    );
    await waitFor(
      () =>
        document.getText().includes('"react": "^19.0.0"') ? true : undefined,
      "workspaces.catalog update"
    );
    assert.ok(document.getText().includes('"zod": "~3.0.0"'));
  });
});
