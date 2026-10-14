import * as assert from "node:assert/strict";

import {
  analyzePeerCompatibility,
  type PeerAnalysisInput,
} from "../../../src/domain/peer-conflict/analysis";
import type { PeerPackageInfo } from "../../../src/domain/peer-conflict/types";

const dependent = (
  name: string,
  version: string,
  peers: Record<string, string>,
  optional: string[] = []
): PeerPackageInfo => ({
  name,
  optionalPeers: optional,
  peerDependencies: peers,
  source: "installed",
  version,
});

const base = (overrides: Partial<PeerAnalysisInput>): PeerAnalysisInput => ({
  candidate: { optionalPeers: [], peerDependencies: {}, version: "7.0.0" },
  dependents: [],
  incomplete: false,
  newerReleasesOf: () => [],
  subject: "vite",
  versionOf: () => {},
  ...overrides,
});

describe("analyzePeerCompatibility", () => {
  it("is compatible when nothing objects", () => {
    const result = analyzePeerCompatibility(
      base({
        dependents: [
          dependent("plugin", "1.0.0", { vite: "^6.0.0 || ^7.0.0" }),
        ],
      })
    );
    assert.equal(result.status, "compatible");
  });

  it("blocks when an installed dependent excludes the candidate", () => {
    const result = analyzePeerCompatibility(
      base({ dependents: [dependent("plugin", "1.0.0", { vite: "^6.0.0" })] })
    );
    assert.equal(result.status, "blocked");
    const [conflict] = result.conflicts;
    assert.equal(conflict?.blocker, "plugin");
    assert.equal(conflict?.requiredRange, "^6.0.0");
    assert.equal(conflict?.confidence, "confirmed");
    assert.equal(conflict?.resolution, undefined);
    assert.deepEqual(result.coordinatedUpgrade, []);
  });

  it("proposes a coordinated upgrade when a newer blocker release relaxes the range", () => {
    const result = analyzePeerCompatibility(
      base({
        dependents: [dependent("plugin", "1.0.0", { vite: "^6.0.0" })],
        newerReleasesOf: () => [
          { peerDependencies: { vite: "^7.0.0" }, version: "2.0.0" },
          { peerDependencies: { vite: "^6.0.0" }, version: "1.1.0" },
        ],
      })
    );
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.conflicts[0]?.resolution, {
      package: "plugin",
      version: "2.0.0",
    });
    assert.deepEqual(result.coordinatedUpgrade, [
      { package: "plugin", version: "2.0.0" },
    ]);
  });

  it("downgrades optional peers to potential conflicts", () => {
    const result = analyzePeerCompatibility(
      base({
        dependents: [
          dependent("plugin", "1.0.0", { vite: "^6.0.0" }, ["vite"]),
        ],
      })
    );
    assert.equal(result.status, "potential-conflict");
    assert.equal(result.conflicts[0]?.optional, true);
  });

  it("flags unevaluable ranges as potential, never as compatible", () => {
    const result = analyzePeerCompatibility(
      base({
        dependents: [dependent("plugin", "1.0.0", { vite: "workspace:*" })],
      })
    );
    assert.equal(result.status, "potential-conflict");
  });

  it("checks the candidate's own peers against installed versions", () => {
    const result = analyzePeerCompatibility(
      base({
        candidate: {
          optionalPeers: [],
          peerDependencies: { node: ">=22", react: "^19.0.0" },
          version: "7.0.0",
        },
        versionOf: (name) => (name === "react" ? "18.2.0" : undefined),
      })
    );
    assert.equal(result.status, "blocked");
    const react = result.conflicts.find((c) => c.blocker === "react");
    assert.equal(react?.direction, "candidate-requires-peer");
    assert.equal(react?.blockerVersion, "18.2.0");
    const missing = result.conflicts.find((c) => c.blocker === "node");
    assert.equal(missing?.confidence, "potential");
  });

  it("ignores missing optional peers of the candidate", () => {
    const result = analyzePeerCompatibility(
      base({
        candidate: {
          optionalPeers: ["sass"],
          peerDependencies: { sass: "^1.0.0" },
          version: "7.0.0",
        },
      })
    );
    assert.equal(result.status, "compatible");
  });

  it("reports unknown when data was incomplete and nothing else is wrong", () => {
    assert.equal(
      analyzePeerCompatibility(base({ incomplete: true })).status,
      "unknown"
    );
  });

  it("still blocks when data is incomplete but a conflict is confirmed", () => {
    const result = analyzePeerCompatibility(
      base({
        dependents: [dependent("plugin", "1.0.0", { vite: "^6.0.0" })],
        incomplete: true,
      })
    );
    assert.equal(result.status, "blocked");
  });
});
