import * as assert from "node:assert/strict";

import { ManifestAnalyzer } from "../../src/application/analyze-manifest/analyze-manifest";
import { parsePackageJson } from "../../src/domain/manifest/package-json";
import {
  FakeAdvisories,
  FakeInstalled,
  FakeRegistry,
  NOW,
  pkg,
} from "./helpers";

/**
 * Coarse regression guards for the documented performance targets. The bounds
 * are deliberately generous so they only trip on algorithmic regressions
 * (accidental quadratic behaviour), not on slow CI machines.
 */
const manifestWith = (count: number): string => {
  const dependencies: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    dependencies[`package-${index}`] = "^1.0.0";
  }
  return JSON.stringify({ dependencies, name: "big" }, null, 2);
};

describe("performance targets", () => {
  it("parses a typical manifest (50 dependencies) well under 50 ms", () => {
    const text = manifestWith(50);
    const start = performance.now();
    for (let run = 0; run < 20; run += 1) {
      parsePackageJson(text);
    }
    const average = (performance.now() - start) / 20;
    assert.ok(average < 50, `average parse took ${average.toFixed(2)} ms`);
  });

  it("parses a very large manifest (5000 dependencies) quickly", () => {
    const text = manifestWith(5000);
    const start = performance.now();
    const parsed = parsePackageJson(text);
    const elapsed = performance.now() - start;
    assert.equal(parsed.declarations.length, 5000);
    assert.ok(elapsed < 1000, `parse took ${elapsed.toFixed(0)} ms`);
  });

  it("analyzes 400 dependencies from cache without quadratic cost", async () => {
    const registry = new FakeRegistry();
    const installed = new FakeInstalled();
    const count = 400;
    for (let index = 0; index < count; index += 1) {
      registry.add(
        pkg(`package-${index}`, { "1.0.0": {}, "1.1.0": {}, "2.0.0": {} })
      );
      installed.add(`package-${index}`, "1.0.0");
    }
    const analyzer = new ManifestAnalyzer({
      advisories: new FakeAdvisories(),
      clock: { now: () => NOW },
      installed,
      registry,
    });
    const run = async () =>
      await analyzer.analyze({
        documentVersion: 1,
        localPackageNames: new Set(),
        manifestDir: "/ws",
        manifestUri: "file:///ws/package.json",
        parsed: parsePackageJson(manifestWith(count)),
        resolveCatalog: () => undefined,
        settings: {
          concurrency: 8,
          peerEnabled: true,
          prerelease: { enabled: false, tags: [] },
          securityEnabled: true,
        },
        workspaceDependencyNames: [],
      });
    const start = performance.now();
    const analysis = await run();
    const elapsed = performance.now() - start;
    assert.equal(analysis.summary.updates, count);
    assert.ok(elapsed < 5000, `analysis took ${elapsed.toFixed(0)} ms`);
  });
});
