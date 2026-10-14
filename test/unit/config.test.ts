import * as assert from "node:assert/strict";

import { parseConfiguration } from "../../src/config/configuration-schema";
import { redactSecrets } from "../../src/shared/redact";

describe("parseConfiguration", () => {
  it("applies documented defaults to empty input", () => {
    const config = parseConfiguration({});
    assert.equal(config.cacheTimeout, 300_000);
    assert.equal(config.codeLens.enabled, true);
    assert.equal(config.codeLens.showUpToDate, false);
    assert.equal(config.minimumReleaseAge, 0);
    assert.equal(config.prerelease.enabled, false);
    assert.deepEqual(config.prerelease.tags, []);
    assert.equal(config.security.enabled, true);
    assert.equal(config.updatePolicy, "conservative");
    assert.equal(config.packageManager, "auto");
    assert.equal(config.analysis.concurrency, 4);
    assert.equal(config.analysis.timeout, 10_000);
    assert.equal(config.logging.level, "warn");
  });

  it("accepts a minimum release age in minutes and rejects invalid values", () => {
    assert.equal(
      parseConfiguration({ minimumReleaseAge: 4320 }).minimumReleaseAge,
      4320
    );
    for (const invalid of [-1, "3 days", 525_601, Number.NaN, null]) {
      assert.equal(
        parseConfiguration({ minimumReleaseAge: invalid }).minimumReleaseAge,
        0,
        `${String(invalid)} falls back to 0`
      );
    }
  });

  it("falls back per field when values are invalid instead of throwing", () => {
    const config = parseConfiguration({
      analysis: { concurrency: 9999, timeout: "fast" },
      cacheTimeout: -5,
      codeLens: { enabled: "yes", showUpToDate: true },
      packageManager: "deno",
      prerelease: { tags: ["beta", 3] },
      updatePolicy: "yolo",
    });
    assert.equal(config.analysis.concurrency, 4);
    assert.equal(config.analysis.timeout, 10_000);
    assert.equal(config.cacheTimeout, 300_000);
    assert.equal(config.codeLens.enabled, true);
    assert.equal(config.codeLens.showUpToDate, true);
    assert.equal(config.packageManager, "auto");
    assert.deepEqual(config.prerelease.tags, []);
    assert.equal(config.updatePolicy, "conservative");
  });

  it("keeps valid user values", () => {
    const config = parseConfiguration({
      analysis: { concurrency: 8 },
      packageManager: "pnpm",
      prerelease: { enabled: true, tags: ["rc"] },
      updatePolicy: "force",
    });
    assert.equal(config.analysis.concurrency, 8);
    assert.equal(config.packageManager, "pnpm");
    assert.deepEqual(config.prerelease.tags, ["rc"]);
    assert.equal(config.updatePolicy, "force");
  });
});

describe("redactSecrets", () => {
  const cases: [string, RegExp][] = [
    ["Authorization: Bearer abc.def.ghi", /Bearer \*\*\*/u],
    [
      "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123",
      /_authToken=\*\*\*/u,
    ],
    ["https://user:hunter2@registry.example.com/x", /\/\/\*\*\*@registry/u],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", /^\*\*\*$/u],
    ["password=hunter2 next", /password=\*\*\* next/u],
  ];
  for (const [input, expected] of cases) {
    it(`masks ${input.slice(0, 24)}…`, () => {
      const output = redactSecrets(input);
      assert.match(output, expected);
      assert.doesNotMatch(
        output,
        /hunter2|npm_abcdefghij|ghp_abc|abc\.def\.ghi/u
      );
    });
  }

  it("leaves ordinary text untouched", () => {
    assert.equal(
      redactSecrets("Updated react to 19.0.0"),
      "Updated react to 19.0.0"
    );
  });
});
