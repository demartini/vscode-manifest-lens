import * as assert from "node:assert/strict";

import { nodeCompatibility } from "../../../src/domain/version/node-compat";

describe("nodeCompatibility", () => {
  const cases: [string | undefined, string | undefined, string][] = [
    [">=18", ">=18", "compatible"],
    [">=18", ">=16", "compatible"],
    ["^18.0.0", ">=18", "compatible"],
    [">=18", "*", "compatible"],
    [">=18", ">=20", "incompatible"],
    [">=18", "^20", "incompatible"],
    // The project promises Node 19 and 21, which this range does not cover.
    [">=18", "^18 || ^20", "incompatible"],
    ["*", ">=20", "incompatible"],
    [undefined, ">=20", "unknown"],
    [">=18", undefined, "unknown"],
    ["garbage", ">=20", "unknown"],
    [">=18", "also bad", "unknown"],
    ["", ">=20", "unknown"],
  ];
  for (const [project, candidate, expected] of cases) {
    it(`project ${String(project)} with a dependency needing ${String(candidate)} is ${expected}`, () => {
      assert.equal(nodeCompatibility(project, candidate), expected);
    });
  }
});
