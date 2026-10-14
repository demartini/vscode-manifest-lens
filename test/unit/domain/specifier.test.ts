import * as assert from "node:assert/strict";

import {
  isRegistryResolvable,
  minimumVersion,
  parseSpecifier,
  registryName,
  rewriteSpecifier,
  satisfiesSpecifier,
} from "../../../src/domain/version/specifier";

describe("parseSpecifier", () => {
  const cases: [string, string][] = [
    ["^1.2.3", "range"],
    ["~1.2.3", "range"],
    ["1.2.3", "range"],
    [">=1.0.0", "range"],
    ["^1.0.0-beta.1", "range"],
    ["^1", "partial"],
    ["1.x", "partial"],
    ["*", "partial"],
    ["", "partial"],
    [">=1.0.0 <2.0.0", "complex"],
    ["^1.0.0 || ^2.0.0", "complex"],
    ["1.0.0 - 2.0.0", "complex"],
    ["latest", "tag"],
    ["next", "tag"],
    ["npm:react@^18.0.0", "alias"],
    ["npm:@scope/pkg@1.0.0", "alias"],
    ["npm:react", "alias"],
    ["workspace:*", "workspace"],
    ["workspace:^1.0.0", "workspace"],
    ["catalog:", "catalog"],
    ["catalog:react18", "catalog"],
    ["file:../local", "local"],
    ["link:../local", "local"],
    ["git+https://github.com/a/b.git", "remote"],
    ["github:a/b", "remote"],
    ["a/b#main", "remote"],
    ["https://example.com/a.tgz", "remote"],
    ["!!!", "invalid"],
  ];
  for (const [input, kind] of cases) {
    it(`classifies ${JSON.stringify(input)} as ${kind}`, () => {
      assert.equal(parseSpecifier(input).kind, kind);
    });
  }

  it("extracts alias targets and catalog names", () => {
    const alias = parseSpecifier("npm:@scope/pkg@^2.0.0");
    assert.ok(alias.kind === "alias");
    assert.equal(alias.target, "@scope/pkg");
    assert.equal(registryName("local-name", alias), "@scope/pkg");
    const named = parseSpecifier("catalog:react18");
    assert.ok(named.kind === "catalog");
    assert.equal(named.catalog, "react18");
    const def = parseSpecifier("catalog:default");
    assert.ok(def.kind === "catalog");
    assert.equal(def.catalog, "");
  });

  it("flags only registry-resolvable specifiers", () => {
    assert.equal(isRegistryResolvable(parseSpecifier("^1.0.0")), true);
    assert.equal(isRegistryResolvable(parseSpecifier("npm:a@1.0.0")), true);
    assert.equal(isRegistryResolvable(parseSpecifier("workspace:*")), false);
    assert.equal(isRegistryResolvable(parseSpecifier("file:../x")), false);
  });
});

describe("rewriteSpecifier", () => {
  const cases: [string, string, string | undefined][] = [
    ["^1.2.3", "2.0.0", "^2.0.0"],
    ["~1.2.3", "2.0.0", "~2.0.0"],
    ["1.2.3", "1.2.4", "1.2.4"],
    [">=1.0.0", "2.1.0", ">=2.1.0"],
    ["^1.2.3", "1.2.3", undefined],
    ["<2.0.0", "3.0.0", undefined],
    ["^1", "2.4.5", "^2"],
    ["1.x", "2.4.5", "2.x"],
    ["1.2.x", "2.4.5", "2.4.x"],
    ["*", "2.0.0", undefined],
    ["latest", "2.0.0", undefined],
    ["workspace:*", "2.0.0", undefined],
    ["file:../x", "2.0.0", undefined],
    [">=1 <2", "2.0.0", undefined],
    ["npm:react@^18.0.0", "19.0.0", "npm:react@^19.0.0"],
    ["npm:react", "19.0.0", undefined],
    ["^1.0.0", "not-a-version", undefined],
    ["^1.0.0", "2.0.0-beta.1", "^2.0.0-beta.1"],
  ];
  for (const [spec, version, expected] of cases) {
    it(`${spec} + ${version} -> ${String(expected)}`, () => {
      assert.equal(rewriteSpecifier(parseSpecifier(spec), version), expected);
    });
  }
});

describe("minimumVersion / satisfiesSpecifier", () => {
  it("derives minimum versions", () => {
    assert.equal(minimumVersion(parseSpecifier("^1.2.3")), "1.2.3");
    assert.equal(minimumVersion(parseSpecifier("1.x")), "1.0.0");
    assert.equal(minimumVersion(parseSpecifier(">1.2.3")), "1.2.4");
    assert.equal(minimumVersion(parseSpecifier("npm:a@~2.1.0")), "2.1.0");
    assert.equal(minimumVersion(parseSpecifier("latest")), undefined);
  });

  it("evaluates satisfaction", () => {
    assert.equal(satisfiesSpecifier(parseSpecifier("^1.2.3"), "1.9.0"), true);
    assert.equal(satisfiesSpecifier(parseSpecifier("^1.2.3"), "2.0.0"), false);
    assert.equal(
      satisfiesSpecifier(parseSpecifier("workspace:*"), "1.0.0"),
      false
    );
  });
});
