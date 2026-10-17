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

describe("selectVersions with a minimum release age", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  const ageOf = (days: number): string =>
    new Date(now - days * DAY).toISOString();
  const releaseAge = { limitMs: () => 3 * DAY, now };
  const select = (
    published: Record<string, string | undefined>,
    extra: Partial<Parameters<typeof selectVersions>[0]> = {}
  ) =>
    selectVersions({
      distTags: {},
      installedVersion: "1.0.0",
      prerelease: noPre,
      releaseAge,
      releases: Object.entries(published).map(([version, publishedAt]) => ({
        version,
        ...(publishedAt === undefined ? {} : { publishedAt }),
      })),
      specifier: parseSpecifier("^1.0.0"),
      ...extra,
    });

  it("holds back versions younger than the limit and targets the newest mature one", () => {
    const result = select({
      "1.0.0": ageOf(100),
      "1.1.0": ageOf(5),
      "1.2.0": ageOf(1),
    });
    assert.equal(result.target?.version, "1.1.0");
    assert.deepEqual(
      result.heldBack.map((candidate) => candidate.version),
      ["1.2.0"]
    );
  });

  it("allows a version that is exactly as old as the limit", () => {
    const result = select({ "1.0.0": ageOf(100), "1.1.0": ageOf(3) });
    assert.equal(result.target?.version, "1.1.0");
    assert.deepEqual(result.heldBack, []);
  });

  it("never holds back a version whose publication date is unknown", () => {
    const result = select({ "1.0.0": ageOf(100), "1.1.0": undefined });
    assert.equal(result.target?.version, "1.1.0");
    assert.deepEqual(result.heldBack, []);
  });

  it("offers no target when every newer version is too young, and still reports them", () => {
    const result = select({ "1.0.0": ageOf(100), "1.1.0": ageOf(1) });
    assert.equal(result.target, undefined);
    assert.deepEqual(
      result.heldBack.map((candidate) => candidate.version),
      ["1.1.0"]
    );
    assert.equal(result.latestPublished, "1.1.0");
  });

  it("is a no-op without a limit or with a limit of zero", () => {
    const published = { "1.0.0": ageOf(100), "1.1.0": ageOf(1) };
    for (const age of [undefined, { limitMs: () => 0, now }]) {
      const result = select(published, {
        ...(age === undefined
          ? { releaseAge: undefined }
          : { releaseAge: age }),
      });
      assert.equal(result.target?.version, "1.1.0");
      assert.deepEqual(result.heldBack, []);
    }
  });

  it("applies a different limit to each version", () => {
    const result = select(
      { "1.0.0": ageOf(100), "1.1.0": ageOf(2), "1.2.0": ageOf(2) },
      {
        releaseAge: {
          limitMs: (version) => (version === "1.1.0" ? 0 : 3 * DAY),
          now,
        },
      }
    );
    assert.equal(result.target?.version, "1.1.0");
    assert.deepEqual(
      result.heldBack.map((candidate) => candidate.version),
      ["1.2.0"]
    );
  });

  it("does not suggest a prerelease younger than the limit", () => {
    const enabled = { enabled: true, tags: [] };
    const young = select(
      { "1.0.0": ageOf(100), "2.0.0-beta.1": ageOf(1) },
      { prerelease: enabled }
    );
    assert.equal(young.prerelease, undefined);
    const mature = select(
      { "1.0.0": ageOf(100), "2.0.0-beta.1": ageOf(10) },
      { prerelease: enabled }
    );
    assert.equal(mature.prerelease?.version, "2.0.0-beta.1");
  });
});

describe("selectVersions for a version that is not published", () => {
  const published = releases(["26.6.0", "26.6.1", "26.6.5", "27.0.0-beta.2"]);
  const check = (spec: string, installed?: string, list = published) =>
    selectVersions({
      distTags: { latest: "26.6.5" },
      prerelease: noPre,
      releases: list,
      specifier: parseSpecifier(spec),
      ...(installed === undefined ? {} : { installedVersion: installed }),
    });

  it("flags a version newer than anything published, and says so is not up to date", () => {
    for (const spec of [
      "^26.6.50",
      "~26.6.50",
      "26.6.50",
      ">=26.6.50",
      "^27.1.0",
    ]) {
      const result = check(spec, "26.6.5");
      assert.equal(result.unpublished?.reason, "ahead-of-latest", spec);
      assert.equal(result.target, undefined, spec);
    }
  });

  it("flags a range no published release satisfies even when it is below the latest", () => {
    assert.equal(check("26.6.3").unpublished?.reason, "no-matching-release");
    assert.equal(check("~26.5.0").unpublished?.reason, "no-matching-release");
    assert.equal(check("^25.0.0").unpublished?.reason, "no-matching-release");
  });

  it("accepts ranges that a published release satisfies", () => {
    for (const spec of [
      "^26.6.1",
      "^26.6.5",
      "26.6.5",
      "~26.6.0",
      ">=26.6.0",
      "26.x",
      "*",
      "^26",
    ]) {
      assert.equal(check(spec, "26.6.5").unpublished, undefined, spec);
    }
  });

  it("treats a published prerelease as published", () => {
    assert.equal(check("^27.0.0-beta.1").unpublished, undefined);
    assert.equal(check("27.0.0-beta.2").unpublished, undefined);
  });

  it("does not flag a deprecated or too-young release, which still exist", () => {
    const list = [
      { deprecated: "old", version: "1.0.0" },
      { publishedAt: "2026-01-09T00:00:00Z", version: "1.1.0" },
    ];
    const result = selectVersions({
      distTags: {},
      prerelease: noPre,
      releaseAge: {
        limitMs: () => 7 * 24 * 60 * 60 * 1000,
        now: Date.parse("2026-01-10T00:00:00Z"),
      },
      releases: list,
      specifier: parseSpecifier("^1.1.0"),
    });
    assert.equal(result.unpublished, undefined);
    assert.equal(check("^1.0.0", undefined, list).unpublished, undefined);
  });

  it("does not apply to tags, protocols or an empty release list of a non-range", () => {
    assert.equal(check("latest").unpublished, undefined);
    assert.equal(check("workspace:*").unpublished, undefined);
  });

  it("looks through npm aliases", () => {
    assert.equal(
      check("npm:pkg@^26.6.50").unpublished?.reason,
      "ahead-of-latest"
    );
    assert.equal(check("npm:pkg@^26.6.1").unpublished, undefined);
  });
});
