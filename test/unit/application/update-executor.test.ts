import * as assert from "node:assert/strict";

import { ManifestAnalyzer } from "../../../src/application/analyze-manifest/analyze-manifest";
import type { ManifestEditorPort } from "../../../src/application/ports";
import { UpdateExecutor } from "../../../src/application/update-dependency/update-executor";
import { applyManifestEdits } from "../../../src/domain/manifest/edits";
import { parsePackageJson } from "../../../src/domain/manifest/package-json";
import type { ManifestEdit } from "../../../src/domain/manifest/types";
import type { InstallResult } from "../../../src/domain/package-manager/types";
import {
  planBulkUpdate,
  planResolveToInstalled,
} from "../../../src/domain/update-plan/plan";
import { ManifestLensError } from "../../../src/shared/errors";
import { err, ok } from "../../../src/shared/result";
import {
  FakeAdvisories,
  FakeInstalled,
  FakeRegistry,
  NOW,
  pkg,
} from "../helpers";

const MANIFEST = `{
  "name": "demo",
  "dependencies": {
    "alpha": "^1.0.0",
    "beta": "~2.0.0"
  }
}
`;

class MemoryEditor implements ManifestEditorPort {
  readonly files = new Map<string, { text: string; version: number }>();
  readonly writes: string[] = [];
  async read(uri: string) {
    const file = this.files.get(uri);
    return {
      isDirty: false,
      text: file?.text ?? "",
      uri,
      version: file?.version ?? 0,
    };
  }
  async apply(
    uri: string,
    edits: readonly ManifestEdit[],
    expectedVersion: number
  ) {
    const file = this.files.get(uri);
    if (file?.version !== expectedVersion) {
      return err(new ManifestLensError("stale", "changed"));
    }
    const edited = applyManifestEdits(file.text, edits);
    if (!edited.ok) {
      return err(edited.error);
    }
    this.files.set(uri, { text: edited.value, version: expectedVersion + 1 });
    this.writes.push(uri);
    return ok();
  }
  fsPath(uri: string) {
    return uri.replace("file://", "");
  }
}

const URI = "file:///repo/packages/app/package.json";

const setup = async () => {
  const editor = new MemoryEditor();
  editor.files.set(URI, { text: MANIFEST, version: 1 });
  const registry = new FakeRegistry()
    .add(pkg("alpha", { "1.0.0": {}, "2.0.0": {} }))
    .add(pkg("beta", { "2.0.0": {}, "2.1.0": {} }));
  const installed = new FakeInstalled().add("alpha", "1.4.0");
  const analyzer = new ManifestAnalyzer({
    advisories: new FakeAdvisories(),
    clock: { now: () => NOW },
    installed,
    registry,
  });
  const analysis = await analyzer.analyze({
    documentVersion: 1,
    localPackageNames: new Set(),
    manifestDir: "/repo/packages/app",
    manifestUri: URI,
    parsed: parsePackageJson(MANIFEST),
    resolveCatalog: () => {},
    settings: {
      concurrency: 2,
      minimumReleaseAge: 0,
      peerEnabled: true,
      prerelease: { enabled: false, tags: [] },
      securityEnabled: false,
    },
    workspaceDependencyNames: [],
  });
  const installs: { root: string; manager: string; flag?: string }[] = [];
  const executor = new UpdateExecutor({
    detect: async (dir) => ({
      evidence: "test",
      manager: "pnpm",
      root: dir.replace("/packages/app", ""),
    }),
    editor,
    install: async (request) => {
      installs.push({
        manager: request.manager,
        root: request.root,
        ...(request.flag ? { flag: request.flag } : {}),
      });
      const result: InstallResult = {
        cancelled: false,
        exitCode: 0,
        success: true,
      };
      return result;
    },
  });
  return { analysis, editor, executor, installs };
};

describe("UpdateExecutor", () => {
  it("rewrites only the selected specifiers, preserving operators, and does not install", async () => {
    const { analysis, editor, executor, installs } = await setup();
    const plan = planBulkUpdate(analysis.items, {
      policy: "conservative",
      scope: "all",
    });
    const result = await executor.apply(plan.eligible, { install: false });
    assert.ok(result.ok);
    assert.equal(
      editor.files.get(URI)?.text,
      MANIFEST.replace("^1.0.0", "^2.0.0").replace("~2.0.0", "~2.1.0")
    );
    assert.deepEqual(result.value.changedManifests, [URI]);
    assert.equal(installs.length, 0);
  });

  it("installs from the lockfile root, once per root, when requested", async () => {
    const { analysis, executor, installs } = await setup();
    const plan = planBulkUpdate(analysis.items, {
      policy: "conservative",
      scope: "all",
    });
    const result = await executor.apply(plan.eligible, {
      install: true,
      installFlag: "--legacy-peer-deps",
    });
    assert.ok(result.ok);
    assert.deepEqual(installs, [
      { flag: "--legacy-peer-deps", manager: "pnpm", root: "/repo" },
    ]);
    assert.equal(result.value.installs[0]?.result.success, true);
  });

  it("aborts without writing anything when the manifest changed since analysis", async () => {
    const { analysis, editor, executor } = await setup();
    const plan = planBulkUpdate(analysis.items, {
      policy: "conservative",
      scope: "all",
    });
    editor.files.set(URI, {
      text: MANIFEST.replace("^1.0.0", "^1.1.0"),
      version: 2,
    });
    const result = await executor.apply(plan.eligible, { install: false });
    assert.equal(!result.ok && result.error.code, "stale");
    assert.equal(editor.writes.length, 0);
  });

  it("detects a concurrent write between validation and save", async () => {
    const { analysis, editor, executor } = await setup();
    const plan = planBulkUpdate(analysis.items, {
      policy: "conservative",
      scope: "all",
    });
    const original = editor.read.bind(editor);
    editor.read = async (uri: string) => {
      const doc = await original(uri);
      editor.files.set(uri, { text: doc.text, version: doc.version + 1 });
      return doc;
    };
    const result = await executor.apply(plan.eligible, { install: false });
    assert.equal(!result.ok && result.error.code, "stale");
  });

  it("resolves a range to the installed version", async () => {
    const { analysis, editor, executor } = await setup();
    const alpha = analysis.items.find(
      (item) => item.declaration.name === "alpha"
    );
    assert.ok(alpha);
    const { update } = planResolveToInstalled(alpha);
    assert.ok(update);
    assert.equal(update.newSpecifier, "^1.4.0");
    const result = await executor.apply([update], { install: false });
    assert.ok(result.ok);
    assert.ok(editor.files.get(URI)?.text.includes('"alpha": "^1.4.0"'));
  });

  it("reports an install failure without losing the applied edits", async () => {
    const { analysis, editor } = await setup();
    const failing = new UpdateExecutor({
      detect: async () => ({ evidence: "t", manager: "npm", root: "/repo" }),
      editor,
      install: async () => ({ cancelled: false, exitCode: 1, success: false }),
    });
    const plan = planBulkUpdate(analysis.items, {
      policy: "conservative",
      scope: "all",
    });
    const result = await failing.apply(plan.eligible, { install: true });
    assert.ok(result.ok);
    assert.equal(result.value.installs[0]?.result.success, false);
    assert.ok(editor.files.get(URI)?.text.includes("^2.0.0"));
  });
});
