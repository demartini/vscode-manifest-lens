import * as assert from "node:assert/strict";

import { ManifestAnalyzer } from "../../../src/application/analyze-manifest/analyze-manifest";
import { parsePackageJson } from "../../../src/domain/manifest/package-json";
import {
  planBulkUpdate,
  planSingleUpdate,
} from "../../../src/domain/update-plan/plan";
import {
  FakeAdvisories,
  FakeInstalled,
  FakeRegistry,
  NOW,
  makeAdvisory,
  pkg,
} from "../helpers";

const analyze = async () => {
  const registry = new FakeRegistry()
    .add(pkg("lib", { "1.0.0": {}, "1.0.1": {}, "1.1.0": {}, "2.0.0": {} }))
    .add(pkg("host", { "1.0.0": { peers: { lib: "^1.0.0" } } }))
    .add(pkg("risky", { "1.0.0": {}, "1.1.0": {} }))
    .add(pkg("star", { "1.0.0": {}, "2.0.0": {} }));
  const installed = new FakeInstalled()
    .add("lib", "1.0.0")
    .add("host", "1.0.0", { lib: "^1.0.0" })
    .add("risky", "1.0.0");
  const advisories = new FakeAdvisories().add(
    "risky",
    "1.1.0",
    makeAdvisory("GHSA-x", "risky", [{ introduced: "1.1.0" }])
  );
  const analyzer = new ManifestAnalyzer({
    advisories,
    clock: { now: () => NOW },
    installed,
    registry,
  });
  const manifest = {
    dependencies: {
      host: "^1.0.0",
      lib: "^1.0.0",
      risky: "^1.0.0",
      star: "*",
    },
  };
  return await analyzer.analyze({
    documentVersion: 1,
    localPackageNames: new Set(),
    manifestDir: "/ws",
    manifestUri: "file:///ws/package.json",
    parsed: parsePackageJson(JSON.stringify(manifest)),
    resolveCatalog: () => {},
    settings: {
      concurrency: 2,
      minimumReleaseAge: 0,
      peerEnabled: true,
      prerelease: { enabled: false, tags: [] },
      securityEnabled: true,
    },
    workspaceDependencyNames: [],
  });
};

describe("update planning", () => {
  it("skips confirmed blockers under the conservative policy and reports why", async () => {
    const { items } = await analyze();
    const plan = planBulkUpdate(items, {
      policy: "conservative",
      scope: "all",
    });
    assert.deepEqual(
      plan.eligible.map((u) => u.analysis.declaration.name),
      ["risky"]
    );
    const lib = plan.skipped.find((s) => s.name === "lib");
    assert.equal(lib?.reason, "blocked");
    assert.match(lib?.detail ?? "", /host/u);
    assert.equal(plan.requiresConfirmation, true);
  });

  it("includes blockers under the force policy and flags the risk", async () => {
    const { items } = await analyze();
    const plan = planBulkUpdate(items, { policy: "force", scope: "all" });
    const lib = plan.eligible.find(
      (u) => u.analysis.declaration.name === "lib"
    );
    assert.equal(lib?.newSpecifier, "^2.0.0");
    assert.ok(lib?.risks.some((risk) => risk.kind === "peer-blocked"));
  });

  it("flags updates that introduce advisories", async () => {
    const { items } = await analyze();
    const plan = planBulkUpdate(items, {
      policy: "conservative",
      scope: "all",
    });
    const risky = plan.eligible.find(
      (u) => u.analysis.declaration.name === "risky"
    );
    const risk = risky?.risks.find((r) => r.kind === "introduces-advisory");
    assert.deepEqual(risk && "ids" in risk ? risk.ids : [], ["GHSA-x"]);
  });

  it("limits scope to patch-level candidates, which peer ranges still allow", async () => {
    const { items } = await analyze();
    const plan = planBulkUpdate(items, {
      policy: "conservative",
      scope: "patch",
    });
    assert.deepEqual(
      plan.eligible.map(
        (u) => `${u.analysis.declaration.name}@${u.candidate.version}`
      ),
      ["lib@1.0.1"]
    );
  });

  it("reports specifiers that cannot be rewritten", async () => {
    const { items } = await analyze();
    const star = items.find((item) => item.declaration.name === "star");
    assert.ok(star?.selection?.target);
    const { skipped, update } = planSingleUpdate(
      star,
      star.selection.target,
      "force"
    );
    assert.equal(update, undefined);
    assert.equal(skipped?.reason, "not-rewritable");
  });
});
