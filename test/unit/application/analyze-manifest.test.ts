import * as assert from "node:assert/strict";

import {
  type AnalyzeRequest,
  ManifestAnalyzer,
} from "../../../src/application/analyze-manifest/analyze-manifest";
import { parsePackageJson } from "../../../src/domain/manifest/package-json";
import {
  FakeAdvisories,
  FakeInstalled,
  FakeRegistry,
  NOW,
  makeAdvisory,
  pkg,
} from "../helpers";

const setup = (
  manifest: Record<string, unknown>,
  overrides: Partial<AnalyzeRequest> = {}
) => {
  const registry = new FakeRegistry();
  const installed = new FakeInstalled();
  const advisories = new FakeAdvisories();
  const analyzer = new ManifestAnalyzer({
    advisories,
    clock: { now: () => NOW },
    installed,
    registry,
  });
  const request: AnalyzeRequest = {
    documentVersion: 1,
    localPackageNames: new Set(),
    manifestDir: "/ws",
    manifestUri: "file:///ws/package.json",
    parsed: parsePackageJson(JSON.stringify(manifest, null, 2)),
    resolveCatalog: () => {},
    settings: {
      concurrency: 2,
      minimumReleaseAge: 0,
      peerEnabled: true,
      prerelease: { enabled: false, tags: [] },
      securityEnabled: true,
    },
    workspaceDependencyNames: [],
    ...overrides,
  };
  return { advisories, analyzer, installed, registry, request };
};

const byName = (
  analysis: Awaited<ReturnType<ManifestAnalyzer["analyze"]>>,
  name: string
) => {
  const item = analysis.items.find(
    (candidate) => candidate.declaration.name === name
  );
  assert.ok(item, `${name} should be analyzed`);
  return item;
};

describe("ManifestAnalyzer", () => {
  it("reports update severity, installed and latest versions", async () => {
    const { analyzer, registry, installed, request } = setup({
      dependencies: { lodash: "^4.17.0", react: "^18.2.0" },
    });
    registry.add(pkg("lodash", { "4.17.0": {}, "4.17.21": {} }));
    registry.add(pkg("react", { "18.2.0": {}, "18.3.1": {}, "19.0.0": {} }));
    installed.add("react", "18.2.0");
    const analysis = await analyzer.analyze(request);
    const react = byName(analysis, "react");
    assert.equal(react.status, "update");
    assert.equal(react.installedVersion, "18.2.0");
    assert.equal(react.latestVersion, "19.0.0");
    assert.equal(react.resolvedVersion, "18.3.1");
    assert.equal(react.selection?.target?.severity, "major");
    assert.equal(react.selection?.minor?.version, "18.3.1");
    const lodash = byName(analysis, "lodash");
    assert.equal(lodash.selection?.target?.version, "4.17.21");
    assert.equal(lodash.selection?.target?.severity, "patch");
    assert.equal(analysis.summary.updates, 2);
  });

  it("marks current dependencies up to date", async () => {
    const { analyzer, registry, installed, request } = setup({
      dependencies: { a: "^1.0.0" },
    });
    registry.add(pkg("a", { "1.0.0": {} }));
    installed.add("a", "1.0.0");
    const analysis = await analyzer.analyze(request);
    assert.equal(byName(analysis, "a").status, "up-to-date");
    assert.equal(analysis.summary.updates, 0);
  });

  it("never reports registry failures as up to date", async () => {
    const { analyzer, registry, request } = setup({
      dependencies: { a: "^1.0.0", b: "^1.0.0" },
    });
    registry.add(pkg("a", { "1.0.0": {} })).fail("b");
    const analysis = await analyzer.analyze(request);
    assert.equal(byName(analysis, "b").status, "error");
    assert.equal(byName(analysis, "b").registry.kind, "error");
    assert.equal(analysis.summary.errors, 1);
    assert.equal(analysis.partial, true);
  });

  it("handles unsupported specifiers explicitly and skips the registry for them", async () => {
    const { analyzer, registry, request } = setup({
      dependencies: {
        aliased: "npm:real@^1.0.0",
        local: "file:../x",
        tagged: "latest",
        wsdep: "workspace:*",
      },
    });
    registry.add(pkg("real", { "1.0.0": {}, "1.1.0": {} }));
    const analysis = await analyzer.analyze(request);
    assert.equal(byName(analysis, "local").status, "unsupported");
    assert.equal(byName(analysis, "wsdep").status, "unsupported");
    assert.equal(byName(analysis, "tagged").status, "unsupported");
    const aliased = byName(analysis, "aliased");
    assert.equal(aliased.registryName, "real");
    assert.equal(aliased.selection?.target?.version, "1.1.0");
    assert.deepEqual(registry.calls, ["real"]);
  });

  it("treats packages from the same workspace as local", async () => {
    const { analyzer, request } = setup(
      { dependencies: { "@acme/ui": "^1.0.0" } },
      { localPackageNames: new Set(["@acme/ui"]) }
    );
    const analysis = await analyzer.analyze(request);
    const ui = byName(analysis, "@acme/ui");
    assert.equal(
      ui.support.kind === "unsupported" && ui.support.reason,
      "workspace"
    );
  });

  it("resolves catalog references and keeps the edit target on the catalog entry", async () => {
    const catalogManifest = parsePackageJson('{"catalog": {"zod": "^3.0.0"}}');
    const [entry] = catalogManifest.declarations;
    assert.ok(entry);
    const { analyzer, registry, request } = setup(
      { dependencies: { zod: "catalog:" } },
      {
        resolveCatalog: (catalog, name) =>
          catalog === "" && name === "zod"
            ? {
                source: {
                  declaration: entry,
                  manifestUri: "file:///ws/pnpm-workspace.yaml",
                },
                specifier: "^3.0.0",
              }
            : undefined,
      }
    );
    registry.add(pkg("zod", { "3.0.0": {}, "3.5.0": {} }));
    const analysis = await analyzer.analyze(request);
    const zod = byName(analysis, "zod");
    assert.equal(
      zod.catalogSource?.manifestUri,
      "file:///ws/pnpm-workspace.yaml"
    );
    assert.equal(zod.selection?.target?.version, "3.5.0");

    const missing = setup({ dependencies: { zod: "catalog:" } });
    const unresolved = byName(
      await missing.analyzer.analyze(missing.request),
      "zod"
    );
    assert.equal(
      unresolved.support.kind === "unsupported" && unresolved.support.reason,
      "catalog-unresolved"
    );
  });

  it("blocks an update that an installed dependent's peer range rejects and suggests the fix", async () => {
    const { analyzer, registry, installed, request } = setup({
      devDependencies: { vite: "^6.0.0", "vite-plugin-x": "^1.0.0" },
    });
    registry.add(pkg("vite", { "6.0.0": {}, "7.0.0": {} }));
    registry.add(
      pkg("vite-plugin-x", {
        "1.0.0": { peers: { vite: "^6.0.0" } },
        "1.1.0": { peers: { vite: "^6.0.0" } },
        "2.0.0": { peers: { vite: "^6.0.0 || ^7.0.0" } },
      })
    );
    installed
      .add("vite", "6.0.0")
      .add("vite-plugin-x", "1.0.0", { vite: "^6.0.0" });
    const analysis = await analyzer.analyze(request);
    const vite = byName(analysis, "vite");
    assert.equal(vite.status, "blocked");
    const peer = vite.peer["7.0.0"];
    assert.equal(peer?.status, "blocked");
    assert.equal(peer?.conflicts[0]?.blocker, "vite-plugin-x");
    assert.deepEqual(peer?.coordinatedUpgrade, [
      { package: "vite-plugin-x", version: "2.0.0" },
    ]);
    assert.equal(analysis.summary.blocked, 1);
  });

  it("offers the newest unblocked candidate when the target is blocked", async () => {
    const { analyzer, registry, installed, request } = setup({
      dependencies: { host: "^1.0.0", lib: "^1.0.0" },
    });
    registry.add(pkg("lib", { "1.0.0": {}, "1.2.0": {}, "2.0.0": {} }));
    registry.add(pkg("host", { "1.0.0": { peers: { lib: "^1.0.0" } } }));
    installed.add("lib", "1.0.0").add("host", "1.0.0", { lib: "^1.0.0" });
    const lib = byName(await analyzer.analyze(request), "lib");
    assert.equal(lib.status, "blocked");
    assert.equal(lib.compatibleCandidate?.version, "1.2.0");
  });

  it("evaluates a candidate's own peers against installed packages", async () => {
    const { analyzer, registry, installed, request } = setup({
      dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
    });
    registry.add(pkg("react", { "18.0.0": {} }));
    registry.add(
      pkg("react-dom", {
        "18.0.0": { peers: { react: "^18.0.0" } },
        "19.0.0": { peers: { react: "^19.0.0" } },
      })
    );
    installed
      .add("react", "18.0.0")
      .add("react-dom", "18.0.0", { react: "^18.0.0" });
    const dom = byName(await analyzer.analyze(request), "react-dom");
    assert.equal(dom.status, "blocked");
    assert.equal(
      dom.peer["19.0.0"]?.conflicts[0]?.direction,
      "candidate-requires-peer"
    );
  });

  it("marks peer data as unknown when a dependent's metadata is unavailable", async () => {
    const { analyzer, registry, request } = setup({
      dependencies: { a: "^1.0.0", b: "^1.0.0" },
    });
    registry.add(pkg("a", { "1.0.0": {}, "2.0.0": {} })).fail("b");
    const a = byName(await analyzer.analyze(request), "a");
    assert.equal(a.peer["2.0.0"]?.status, "unknown");
    assert.equal(a.status, "update");
  });

  it("reports advisories for the current version and those a candidate would introduce", async () => {
    const { advisories, analyzer, registry, installed, request } = setup({
      dependencies: { a: "^1.0.0" },
    });
    registry.add(pkg("a", { "1.0.0": {}, "1.1.0": {}, "2.0.0": {} }));
    installed.add("a", "1.0.0");
    advisories.add(
      "a",
      "1.0.0",
      makeAdvisory("GHSA-old", "a", [{ introduced: "0" }, { fixed: "1.1.0" }])
    );
    advisories.add(
      "a",
      "1.0.0",
      makeAdvisory(
        "GHSA-old",
        "a",
        [{ introduced: "0" }, { fixed: "1.1.0" }],
        ["CVE-1"]
      )
    );
    advisories.add(
      "a",
      "2.0.0",
      makeAdvisory("GHSA-new", "a", [{ introduced: "2.0.0" }])
    );
    const analysis = await analyzer.analyze(request);
    const a = byName(analysis, "a");
    const current = a.security["1.0.0"];
    assert.equal(current?.state === "checked" && current.advisories.length, 1);
    assert.equal(
      current?.state === "checked" && current.advisories[0]?.fixedVersions[0],
      "1.1.0"
    );
    const target = a.security["2.0.0"];
    assert.equal(
      target?.state === "checked" && target.advisories[0]?.advisory.id,
      "GHSA-new"
    );
    assert.equal(analysis.summary.vulnerable, 1);
    assert.equal(analysis.summary.advisories, 1);
  });

  it("does not claim a clean result when the advisory lookup fails", async () => {
    const { advisories, analyzer, registry, installed, request } = setup({
      dependencies: { a: "^1.0.0" },
    });
    registry.add(pkg("a", { "1.0.0": {} }));
    installed.add("a", "1.0.0");
    advisories.failAll = true;
    const analysis = await analyzer.analyze(request);
    assert.equal(byName(analysis, "a").security["1.0.0"]?.state, "unknown");
    assert.equal(analysis.partial, true);
  });

  it("falls back to the declared minimum when nothing is installed", async () => {
    const { advisories, analyzer, registry, request } = setup({
      dependencies: { a: "^1.2.0" },
    });
    registry.add(pkg("a", { "1.2.0": {}, "1.3.0": {} }));
    const a = byName(await analyzer.analyze(request), "a");
    assert.equal(a.currentVersion, "1.2.0");
    assert.equal(a.currentVersionBasis, "declared-minimum");
    assert.ok(advisories.queries.includes("a@1.2.0"));
  });

  it("flags deprecated releases", async () => {
    const { analyzer, registry, installed, request } = setup({
      dependencies: { a: "^1.0.0" },
    });
    registry.add(pkg("a", { "1.0.0": { deprecated: "use b" } }));
    installed.add("a", "1.0.0");
    assert.equal(
      byName(await analyzer.analyze(request), "a").deprecation?.message,
      "use b"
    );
  });

  it("exposes the license and Node engine of the current version and of each update candidate", async () => {
    const { analyzer, registry, installed, request } = setup({
      dependencies: { a: "^1.0.0" },
    });
    registry.add(
      pkg("a", {
        "1.0.0": { license: "MIT", nodeEngine: ">=18" },
        "1.1.0": { license: "MIT", nodeEngine: ">=20" },
        "2.0.0": { nodeEngine: ">=22" },
      })
    );
    installed.add("a", "1.0.0");
    const { releaseDetails } = byName(await analyzer.analyze(request), "a");
    assert.deepEqual(releaseDetails["1.0.0"], {
      license: "MIT",
      nodeEngine: ">=18",
    });
    assert.deepEqual(releaseDetails["1.1.0"], {
      license: "MIT",
      nodeEngine: ">=20",
    });
    assert.deepEqual(releaseDetails["2.0.0"], { nodeEngine: ">=22" });
  });

  it("leaves release details empty when the registry is unavailable", async () => {
    const { analyzer, registry, request } = setup({
      dependencies: { a: "^1.0.0" },
    });
    registry.fail("a");
    assert.deepEqual(
      byName(await analyzer.analyze(request), "a").releaseDetails,
      {}
    );
  });

  it("holds back versions younger than the configured minimum release age", async () => {
    const make = (minutes: number) => {
      const { analyzer, registry, installed, request } = setup(
        { dependencies: { a: "^1.0.0" } },
        {
          settings: {
            concurrency: 2,
            minimumReleaseAge: minutes,
            peerEnabled: true,
            prerelease: { enabled: false, tags: [] },
            securityEnabled: true,
          },
        }
      );
      registry.add(pkg("a", { "1.0.0": {}, "1.1.0": {} }));
      installed.add("a", "1.0.0");
      return { analyzer, request };
    };
    // The fake registry publishes every version 4 days before NOW (5760 minutes).
    const strict = make(7 * 1440);
    const held = byName(await strict.analyzer.analyze(strict.request), "a");
    assert.equal(held.selection?.target, undefined);
    assert.equal(held.selection?.heldBack.length, 1);
    assert.equal(held.status, "up-to-date");
    const relaxed = make(1440);
    const open = byName(await relaxed.analyzer.analyze(relaxed.request), "a");
    assert.equal(open.selection?.target?.version, "1.1.0");
    assert.equal(open.selection?.heldBack.length, 0);
  });

  it("links the npm versions tab and, for known hosts, the repository releases", async () => {
    const { analyzer, registry, request } = setup({
      dependencies: { a: "^1.0.0", b: "^1.0.0" },
    });
    registry.add(
      pkg("a", { "1.0.0": {} }, undefined, {
        repositoryUrl: "https://github.com/o/a",
      })
    );
    registry.add(pkg("b", { "1.0.0": {} }));
    const analysis = await analyzer.analyze(request);
    assert.equal(
      byName(analysis, "a").links.versions,
      "https://www.npmjs.com/package/a?activeTab=versions"
    );
    assert.equal(
      byName(analysis, "a").links.releases,
      "https://github.com/o/a/releases"
    );
    assert.equal(byName(analysis, "b").links.releases, undefined);
  });

  describe("package manager release age", () => {
    // The fake registry publishes every version 4 days before NOW (5760 minutes).
    const analyze = async (
      managerReleaseAge: AnalyzeRequest["managerReleaseAge"],
      ownMinutes = 0
    ) => {
      const { analyzer, registry, installed, request } = setup(
        { dependencies: { a: "^1.0.0" } },
        {
          managerReleaseAge,
          settings: {
            concurrency: 2,
            minimumReleaseAge: ownMinutes,
            peerEnabled: true,
            prerelease: { enabled: false, tags: [] },
            securityEnabled: true,
          },
        }
      );
      registry.add(pkg("a", { "1.0.0": {}, "1.1.0": {} }));
      installed.add("a", "1.0.0");
      return byName(await analyzer.analyze(request), "a");
    };

    it("holds back versions the package manager would refuse to install", async () => {
      const held = await analyze({ exclude: [], minimumMinutes: 7 * 1440 });
      assert.equal(held.selection?.target, undefined);
      assert.equal(held.selection?.heldBack.length, 1);
      const open = await analyze({ exclude: [], minimumMinutes: 1440 });
      assert.equal(open.selection?.target?.version, "1.1.0");
    });

    it("exempts packages and versions the package manager excludes", async () => {
      for (const exclude of ["a", "a@1.1.0", "a@1.0.0 || 1.1.0"]) {
        const result = await analyze({
          exclude: [exclude],
          minimumMinutes: 7 * 1440,
        });
        assert.equal(result.selection?.target?.version, "1.1.0", exclude);
      }
      const other = await analyze({
        exclude: ["a@1.2.0"],
        minimumMinutes: 7 * 1440,
      });
      assert.equal(other.selection?.target, undefined);
    });

    it("keeps the stricter of the user setting and the package manager", async () => {
      const result = await analyze(
        { exclude: ["a"], minimumMinutes: 1440 },
        7 * 1440
      );
      assert.equal(
        result.selection?.target,
        undefined,
        "the explicit setting is not lifted by the manager's exclusion"
      );
    });
  });

  it("never reports a declared version that is not published as up to date", async () => {
    const { analyzer, registry, installed, request } = setup({
      dependencies: { ahead: "^1.0.50", fine: "^1.0.5", typo: "1.0.3" },
    });
    registry.add(pkg("ahead", { "1.0.0": {}, "1.0.5": {} }));
    registry.add(pkg("fine", { "1.0.0": {}, "1.0.5": {} }));
    registry.add(pkg("typo", { "1.0.0": {}, "1.0.5": {} }));
    installed.add("ahead", "1.0.5").add("fine", "1.0.5");
    const analysis = await analyzer.analyze(request);
    const ahead = byName(analysis, "ahead");
    assert.equal(ahead.status, "unpublished");
    assert.equal(ahead.selection?.unpublished?.reason, "ahead-of-latest");
    assert.equal(ahead.selection?.baseVersion, "1.0.50");
    assert.equal(ahead.selection?.latestPublished, "1.0.5");
    // A pinned version that does not exist still has something newer to offer.
    const typo = byName(analysis, "typo");
    assert.equal(typo.selection?.unpublished?.reason, "no-matching-release");
    assert.equal(typo.status, "update");
    assert.equal(typo.selection?.target?.version, "1.0.5");
    assert.equal(byName(analysis, "fine").status, "up-to-date");
    assert.equal(analysis.summary.unpublished, 2);
    assert.equal(analysis.summary.updates, 1);
  });

  it("skips security and peer work when disabled", async () => {
    const { advisories, analyzer, registry, request } = setup(
      { dependencies: { a: "^1.0.0" } },
      {
        settings: {
          concurrency: 1,
          minimumReleaseAge: 0,
          peerEnabled: false,
          prerelease: { enabled: false, tags: [] },
          securityEnabled: false,
        },
      }
    );
    registry.add(pkg("a", { "1.0.0": {}, "2.0.0": {} }));
    const a = byName(await analyzer.analyze(request), "a");
    assert.deepEqual(a.peer, {});
    assert.deepEqual(a.security, {});
    assert.equal(advisories.queries.length, 0);
  });

  it("rejects with a cancellation error when aborted", async () => {
    const { analyzer, registry, request } = setup({
      dependencies: { a: "^1.0.0" },
    });
    registry.add(pkg("a", { "1.0.0": {} }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      analyzer.analyze({ ...request, signal: controller.signal }),
      /cancelled/u
    );
  });
});
