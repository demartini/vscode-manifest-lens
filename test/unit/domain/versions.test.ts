import * as assert from "node:assert/strict";

import { selectVersions } from "../../../src/domain/version/candidates";
import {
  classifyUpdate,
  isPotentiallyBreaking,
} from "../../../src/domain/version/classification";
import { parseSpecifier } from "../../../src/domain/version/specifier";

describe("classifyUpdate", () => {
  const cases: [string, string, string][] = [
    ["1.0.0", "2.0.0", "major"],
    ["1.0.0", "1.1.0", "minor"],
    ["1.0.0", "1.0.1", "patch"],
    ["1.0.0", "2.0.0-beta.1", "prerelease"],
    ["0.3.0", "0.4.0", "minor"],
    ["1.0.0-rc.1", "1.0.0", "patch"],
    ["nope", "1.0.0", "unknown"],
  ];
  for (const [from, to, expected] of cases) {
    it(`${from} -> ${to} is ${expected}`, () => {
      assert.equal(classifyUpdate(from, to), expected);
    });
  }

  it("flags 0.x minor bumps as potentially breaking", () => {
    assert.equal(isPotentiallyBreaking("0.3.0", "0.4.0"), true);
    assert.equal(isPotentiallyBreaking("0.0.1", "0.0.2"), true);
    assert.equal(isPotentiallyBreaking("1.2.0", "1.3.0"), false);
    assert.equal(isPotentiallyBreaking("1.2.0", "2.0.0"), true);
    assert.equal(isPotentiallyBreaking("2.0.0", "1.0.0"), false);
  });
});

const releases = (versions: string[]) =>
  versions.map((version) => ({ version }));
const noPre = { enabled: false, tags: [] };

describe("selectVersions", () => {
  const all = releases([
    "1.0.0",
    "1.1.0",
    "1.1.1",
    "1.2.0",
    "2.0.0",
    "2.0.1",
    "3.0.0-beta.1",
    "3.0.0-rc.1",
  ]);

  it("splits candidates by severity relative to the installed version", () => {
    const result = selectVersions({
      distTags: { latest: "2.0.1" },
      installedVersion: "1.1.0",
      prerelease: noPre,
      releases: all,
      specifier: parseSpecifier("^1.0.0"),
    });
    assert.equal(result.baseVersion, "1.1.0");
    assert.equal(result.target?.version, "2.0.1");
    assert.equal(result.target?.severity, "major");
    assert.equal(result.major?.version, "2.0.1");
    assert.equal(result.minor?.version, "1.2.0");
    assert.equal(result.patch?.version, "1.1.1");
    assert.equal(result.latestPublished, "2.0.1");
    assert.equal(result.latestSatisfying, "1.2.0");
    assert.equal(result.prerelease, undefined);
  });

  it("falls back to the declared minimum when nothing is installed", () => {
    const result = selectVersions({
      distTags: {},
      prerelease: noPre,
      releases: all,
      specifier: parseSpecifier("^1.2.0"),
    });
    assert.equal(result.baseVersion, "1.2.0");
    assert.equal(result.target?.version, "2.0.1");
  });

  it("reports no target when current", () => {
    const result = selectVersions({
      distTags: { latest: "2.0.1" },
      installedVersion: "2.0.1",
      prerelease: noPre,
      releases: all,
      specifier: parseSpecifier("^2.0.0"),
    });
    assert.equal(result.target, undefined);
    assert.deepEqual(result.stableCandidates, []);
  });

  it("never replaces stable with prerelease unless enabled, and honours tags", () => {
    const base = {
      distTags: {},
      installedVersion: "2.0.1",
      releases: all,
      specifier: parseSpecifier("^2.0.0"),
    };
    assert.equal(
      selectVersions({ ...base, prerelease: noPre }).prerelease,
      undefined
    );
    const any = selectVersions({
      ...base,
      prerelease: { enabled: true, tags: [] },
    });
    assert.equal(any.prerelease?.version, "3.0.0-rc.1");
    assert.equal(any.prerelease?.severity, "prerelease");
    const beta = selectVersions({
      ...base,
      prerelease: { enabled: true, tags: ["beta"] },
    });
    assert.equal(beta.prerelease?.version, "3.0.0-beta.1");
    assert.equal(any.target, undefined);
  });

  it("skips deprecated releases while other options exist", () => {
    const result = selectVersions({
      distTags: {},
      installedVersion: "1.0.0",
      prerelease: noPre,
      releases: [
        { version: "1.0.0" },
        { version: "1.1.0" },
        { deprecated: "broken", version: "1.2.0" },
      ],
      specifier: parseSpecifier("^1.0.0"),
    });
    assert.equal(result.target?.version, "1.1.0");
  });

  it("returns no base for tags and protocols", () => {
    const result = selectVersions({
      distTags: { latest: "2.0.0" },
      prerelease: noPre,
      releases: all,
      specifier: parseSpecifier("latest"),
    });
    assert.equal(result.baseVersion, undefined);
    assert.equal(result.target, undefined);
    assert.equal(result.latestPublished, "2.0.0");
  });

  it("ignores an installed version that does not satisfy the range", () => {
    const result = selectVersions({
      distTags: {},
      installedVersion: "0.9.0",
      prerelease: noPre,
      releases: all,
      specifier: parseSpecifier("^1.1.0"),
    });
    assert.equal(result.baseVersion, "1.1.0");
  });
});
