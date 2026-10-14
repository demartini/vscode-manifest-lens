import * as assert from "node:assert/strict";

import {
  isExcludedFromReleaseAge,
  parseBunReleaseAge,
  parseNpmReleaseAge,
  parsePnpmReleaseAge,
} from "../../../src/domain/package-manager/release-age";

describe("parsePnpmReleaseAge", () => {
  it("reads the age in minutes and the exclusions", () => {
    assert.deepEqual(
      parsePnpmReleaseAge(
        [
          "packages:",
          "  - packages/*",
          "minimumReleaseAge: 10080",
          "minimumReleaseAgeExclude:",
          "  - webpack",
          "  - '@myorg/*'",
          "  - nx@21.6.5",
        ].join("\n")
      ),
      { exclude: ["webpack", "@myorg/*", "nx@21.6.5"], minimumMinutes: 10_080 }
    );
  });

  it("returns nothing when the setting is absent, zero or invalid", () => {
    for (const text of [
      "packages:\n  - a",
      "minimumReleaseAge: 0",
      "minimumReleaseAge: -5",
      "minimumReleaseAge: soon",
      "nested:\n  minimumReleaseAge: 1440",
      "minimumReleaseAge: [1",
      "",
    ]) {
      assert.equal(parsePnpmReleaseAge(text), undefined, JSON.stringify(text));
    }
  });

  it("ignores exclusions that are not strings", () => {
    assert.deepEqual(
      parsePnpmReleaseAge(
        "minimumReleaseAge: 60\nminimumReleaseAgeExclude:\n  - a\n  - 3\n  - {x: 1}\n"
      ),
      { exclude: ["a"], minimumMinutes: 60 }
    );
  });
});

describe("parseBunReleaseAge", () => {
  it("converts the seconds under [install] into minutes and reads the exclusions", () => {
    assert.deepEqual(
      parseBunReleaseAge(
        [
          "[install]",
          "# only versions at least 3 days old",
          "minimumReleaseAge = 259200 # three days",
          "minimumReleaseAgeExcludes = [\"@types/bun\", 'typescript']",
        ].join("\n")
      ),
      { exclude: ["@types/bun", "typescript"], minimumMinutes: 4320 }
    );
  });

  it("reads multi-line arrays", () => {
    assert.deepEqual(
      parseBunReleaseAge(
        [
          "[install]",
          "minimumReleaseAge = 3600",
          "minimumReleaseAgeExcludes = [",
          '  "a", # first',
          '  "b",',
          "]",
        ].join("\n")
      ),
      { exclude: ["a", "b"], minimumMinutes: 60 }
    );
  });

  it("rounds partial minutes up", () => {
    assert.equal(
      parseBunReleaseAge("[install]\nminimumReleaseAge = 30")?.minimumMinutes,
      1
    );
  });

  it("only reads keys from the [install] table", () => {
    for (const text of [
      "minimumReleaseAge = 3600",
      "[run]\nminimumReleaseAge = 3600",
      "[install.cache]\nminimumReleaseAge = 3600",
      "[install]\nlockfile = true",
      "[install]\nminimumReleaseAge = 'abc'",
      "[install]\nminimumReleaseAge = -1",
      "",
    ]) {
      assert.equal(parseBunReleaseAge(text), undefined, JSON.stringify(text));
    }
  });

  it("stops reading [install] at the next table", () => {
    assert.deepEqual(
      parseBunReleaseAge(
        "[install]\nminimumReleaseAge = 60\n[run]\nminimumReleaseAgeExcludes = ['x']"
      ),
      { exclude: [], minimumMinutes: 1 }
    );
  });
});

describe("parseNpmReleaseAge", () => {
  it("converts days into minutes", () => {
    assert.equal(
      parseNpmReleaseAge("min-release-age=7")?.minimumMinutes,
      10_080
    );
    assert.equal(
      parseNpmReleaseAge("; comment\n  min-release-age = 0.5 \n")
        ?.minimumMinutes,
      720
    );
    assert.deepEqual(parseNpmReleaseAge("min-release-age=1")?.exclude, []);
  });

  it("ignores comments, other keys and invalid values", () => {
    for (const text of [
      "# min-release-age=7",
      "registry=https://registry.npmjs.org/",
      "min-release-age=abc",
      "min-release-age=-1",
      "min-release-age=0",
      "before=2026-01-01",
      "",
    ]) {
      assert.equal(parseNpmReleaseAge(text), undefined, JSON.stringify(text));
    }
  });
});

describe("isExcludedFromReleaseAge", () => {
  it("matches names, scope globs and exact versions", () => {
    const exclude = [
      "webpack",
      "@myorg/*",
      "nx@21.6.5",
      "tsup@4.47.0 || 5.102.1",
    ];
    assert.equal(isExcludedFromReleaseAge(exclude, "webpack", "5.0.0"), true);
    assert.equal(isExcludedFromReleaseAge(exclude, "@myorg/ui", "1.0.0"), true);
    assert.equal(
      isExcludedFromReleaseAge(exclude, "@other/ui", "1.0.0"),
      false
    );
    assert.equal(isExcludedFromReleaseAge(exclude, "nx", "21.6.5"), true);
    assert.equal(isExcludedFromReleaseAge(exclude, "nx", "21.6.6"), false);
    assert.equal(isExcludedFromReleaseAge(exclude, "tsup", "5.102.1"), true);
    assert.equal(isExcludedFromReleaseAge(exclude, "tsup", "4.47.0"), true);
    assert.equal(isExcludedFromReleaseAge(exclude, "tsup", "6.0.0"), false);
    assert.equal(isExcludedFromReleaseAge(exclude, "react", "19.0.0"), false);
  });

  it("matches a scoped package pinned to a version", () => {
    assert.equal(
      isExcludedFromReleaseAge(["@scope/pkg@1.2.3"], "@scope/pkg", "1.2.3"),
      true
    );
    assert.equal(
      isExcludedFromReleaseAge(["@scope/pkg@1.2.3"], "@scope/pkg", "1.2.4"),
      false
    );
  });

  it("treats regular expression characters in patterns literally", () => {
    assert.equal(isExcludedFromReleaseAge(["a.b"], "axb", "1.0.0"), false);
    assert.equal(isExcludedFromReleaseAge(["a+(b"], "a+(b", "1.0.0"), true);
  });
});
