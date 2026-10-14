import * as assert from "node:assert/strict";

import {
  applyManifestEdits,
  createSpecifierEdit,
  relocateDeclaration,
} from "../../../src/domain/manifest/edits";
import { parsePackageJson } from "../../../src/domain/manifest/package-json";
import { overrideTargetName } from "../../../src/domain/manifest/package-name";
import { parsePnpmWorkspace } from "../../../src/domain/manifest/pnpm-workspace";
import { computeSortEdits } from "../../../src/domain/manifest/sort";

const PACKAGE = `{
  // comment
  "name": "demo",
  "version": "1.0.0",
  "packageManager": "pnpm@9.1.0",
  "workspaces": ["packages/*"],
  "dependencies": {
    "react": "^18.2.0",
    "@scope/pkg": "~1.2.3",
    "aliased": "npm:real@^2.0.0",
  },
  "devDependencies": { "vite": "6.0.0" },
  "overrides": { "foo@<2": "2.0.0", "bar": { ".": "1.0.0" }, "baz": "$react" },
  "pnpm": { "overrides": { "qux": "^3.0.0" } },
  "catalog": { "zod": "^3.0.0" },
  "catalogs": { "legacy": { "left-pad": "1.0.0" } }
}`;

describe("parsePackageJson", () => {
  const parsed = parsePackageJson(PACKAGE);

  it("reads metadata and tolerates comments and trailing commas", () => {
    assert.equal(parsed.name, "demo");
    assert.equal(parsed.packageManager, "pnpm@9.1.0");
    assert.deepEqual(parsed.workspaces, ["packages/*"]);
    assert.deepEqual(parsed.issues, []);
  });

  it("extracts declarations from every supported section", () => {
    const summary = parsed.declarations.map(
      (d) => `${d.section}:${d.catalog ?? ""}:${d.name}=${d.specifier}`
    );
    assert.deepEqual(summary, [
      "dependencies::react=^18.2.0",
      "dependencies::@scope/pkg=~1.2.3",
      "dependencies::aliased=npm:real@^2.0.0",
      "devDependencies::vite=6.0.0",
      "overrides::foo=2.0.0",
      "overrides::qux=^3.0.0",
      "catalog::zod=^3.0.0",
      "catalog:legacy:left-pad=1.0.0",
    ]);
  });

  it("marks override targets as transitive", () => {
    assert.equal(
      parsed.declarations.find((d) => d.name === "foo")?.direct,
      false
    );
    assert.equal(
      parsed.declarations.find((d) => d.name === "react")?.direct,
      true
    );
  });

  it("records exact spans for the specifier token", () => {
    const react = parsed.declarations.find((d) => d.name === "react");
    assert.ok(react);
    assert.equal(
      PACKAGE.slice(react.valueSpan.start, react.valueSpan.end),
      '"^18.2.0"'
    );
    assert.equal(react.rawValue, '"^18.2.0"');
    assert.equal(
      PACKAGE.slice(react.nameSpan.start, react.nameSpan.end),
      '"react"'
    );
  });

  it("exposes section anchors", () => {
    const deps = parsed.sections.find((s) => s.id === "dependencies");
    assert.ok(deps);
    assert.equal(deps.declarationIds.length, 3);
    assert.equal(
      PACKAGE.slice(deps.keySpan.start, deps.keySpan.end),
      '"dependencies"'
    );
  });

  it("handles malformed or non-object input without throwing", () => {
    assert.equal(parsePackageJson("[]").declarations.length, 0);
    assert.equal(parsePackageJson("").declarations.length, 0);
    assert.ok(
      parsePackageJson('{"dependencies": {"a": "1.0.0"').declarations.length >=
        0
    );
  });
});

describe("overrideTargetName", () => {
  it("normalizes keys", () => {
    assert.equal(overrideTargetName("foo@<2"), "foo");
    assert.equal(overrideTargetName("@scope/foo@1"), "@scope/foo");
    assert.equal(overrideTargetName("**/foo"), "foo");
    assert.equal(overrideTargetName("a>b"), undefined);
  });
});

const WORKSPACE = `packages:
  - "packages/*"
catalog:
  react: ^18.2.0
  "@scope/pkg": '~1.0.0'
  quoted: "2.0.0"
catalogs:
  next:
    react: ^19.0.0
overrides:
  lodash: 4.17.21
`;

describe("parsePnpmWorkspace", () => {
  const parsed = parsePnpmWorkspace(WORKSPACE);

  it("extracts catalogs, named catalogs and overrides", () => {
    assert.deepEqual(
      parsed.declarations.map(
        (d) => `${d.section}:${d.catalog ?? ""}:${d.name}=${d.specifier}`
      ),
      [
        "catalog::react=^18.2.0",
        "catalog::@scope/pkg=~1.0.0",
        "catalog::quoted=2.0.0",
        "catalog:next:react=^19.0.0",
        "overrides::lodash=4.17.21",
      ]
    );
    assert.deepEqual(parsed.workspaces, ["packages/*"]);
  });

  it("tracks quoting so edits stay valid YAML", () => {
    const edits = parsed.declarations.map((d) => ({
      d,
      edit: createSpecifierEdit(d, ">=2.0.0"),
    }));
    const byName = (name: string) =>
      edits.find((e) => e.d.name === name)?.edit.replacement;
    assert.equal(byName("react"), '">=2.0.0"');
    assert.equal(byName("@scope/pkg"), "'>=2.0.0'");
    assert.equal(byName("quoted"), '">=2.0.0"');
    const [first] = parsed.declarations;
    assert.ok(first);
    assert.equal(createSpecifierEdit(first, "^19.0.0").replacement, "^19.0.0");
  });

  it("ignores non-mapping roots", () => {
    assert.equal(parsePnpmWorkspace("- a\n- b").declarations.length, 0);
    assert.equal(parsePnpmWorkspace("").issues.length, 0);
  });
});

describe("applyManifestEdits", () => {
  it("rewrites only the targeted token and preserves everything else", () => {
    const parsed = parsePackageJson(PACKAGE);
    const react = parsed.declarations.find((d) => d.name === "react");
    assert.ok(react);
    const result = applyManifestEdits(PACKAGE, [
      createSpecifierEdit(react, "^19.0.0"),
    ]);
    assert.ok(result.ok);
    assert.equal(result.value, PACKAGE.replace('"^18.2.0"', '"^19.0.0"'));
  });

  it("applies several edits at once", () => {
    const parsed = parsePackageJson(PACKAGE);
    const edits = parsed.declarations
      .filter((d) => d.name === "react" || d.name === "vite")
      .map((d) => createSpecifierEdit(d, "9.9.9"));
    const result = applyManifestEdits(PACKAGE, edits);
    assert.ok(result.ok);
    assert.ok(result.value.includes('"react": "9.9.9"'));
    assert.ok(result.value.includes('"vite": "9.9.9"'));
  });

  it("rejects edits when the document changed", () => {
    const parsed = parsePackageJson(PACKAGE);
    const react = parsed.declarations.find((d) => d.name === "react");
    assert.ok(react);
    const changed = PACKAGE.replace("^18.2.0", "^18.3.0");
    const result = applyManifestEdits(changed, [
      createSpecifierEdit(react, "^19.0.0"),
    ]);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "stale");
  });

  it("relocates declarations only when unchanged", () => {
    const parsed = parsePackageJson(PACKAGE);
    const react = parsed.declarations.find((d) => d.name === "react");
    assert.ok(react);
    assert.ok(relocateDeclaration(react, parsePackageJson(`\n\n${PACKAGE}`)));
    assert.equal(
      relocateDeclaration(
        react,
        parsePackageJson(PACKAGE.replace("^18.2.0", "^18.3.0"))
      ),
      undefined
    );
  });
});

describe("computeSortEdits", () => {
  it("sorts dependency sections and keeps formatting", () => {
    const text = `{\n  "dependencies": {\n    "b": "1.0.0",\n    "a": "1.0.0",\n    "@c/x": "2.0.0"\n  }\n}`;
    const { edits } = computeSortEdits(text);
    const result = applyManifestEdits(text, edits);
    assert.ok(result.ok);
    assert.equal(
      result.value,
      `{\n  "dependencies": {\n    "@c/x": "2.0.0",\n    "a": "1.0.0",\n    "b": "1.0.0"\n  }\n}`
    );
  });

  it("does nothing when already sorted", () => {
    const text = `{"dependencies": {"a": "1", "b": "2"}}`;
    assert.equal(computeSortEdits(text).edits.length, 0);
  });

  it("refuses to sort sections containing comments", () => {
    const text = `{"dependencies": {"b": "1", // keep\n "a": "2"}}`;
    const result = computeSortEdits(text);
    assert.equal(result.edits.length, 0);
    assert.deepEqual(result.skipped, ["dependencies"]);
  });
});

describe("bun catalogs in package.json", () => {
  const bun = `{
  "name": "root",
  "workspaces": {
    "packages": ["packages/*"],
    "catalog": { "react": "^19.0.0", "@scope/pkg": "~1.0.0" },
    "catalogs": { "testing": { "vitest": "^3.0.0" } }
  },
  "catalog": { "zod": "^4.0.0" },
  "catalogs": { "legacy": { "left-pad": "1.0.0" } },
  "dependencies": { "react": "catalog:" }
}`;
  const parsed = parsePackageJson(bun);

  it("reads workspaces.catalog, workspaces.catalogs and top-level catalogs", () => {
    const catalogs = parsed.declarations
      .filter((d) => d.section === "catalog")
      .map((d) => `${d.catalog ?? ""}:${d.name}=${d.specifier}`);
    assert.deepEqual(catalogs, [
      ":zod=^4.0.0",
      "legacy:left-pad=1.0.0",
      ":react=^19.0.0",
      ":@scope/pkg=~1.0.0",
      "testing:vitest=^3.0.0",
    ]);
    assert.deepEqual(parsed.workspaces, ["packages/*"]);
  });

  it("keeps catalog references as ordinary dependencies and edits catalog entries in place", () => {
    const ref = parsed.declarations.find((d) => d.section === "dependencies");
    assert.equal(ref?.specifier, "catalog:");
    const entry = parsed.declarations.find(
      (d) => d.name === "react" && d.section === "catalog"
    );
    assert.ok(entry);
    const result = applyManifestEdits(bun, [
      createSpecifierEdit(entry, "^20.0.0"),
    ]);
    assert.ok(result.ok);
    assert.ok(result.value.includes('"react": "^20.0.0"'));
    assert.ok(result.value.includes('"react": "catalog:"'));
  });
});

describe("parsePackageJson engines", () => {
  it("reads the Node range the project declares", () => {
    assert.equal(
      parsePackageJson('{ "engines": { "node": ">=18" } }').nodeEngine,
      ">=18"
    );
  });

  it("ignores missing or malformed engines", () => {
    for (const text of [
      "{}",
      '{ "engines": [] }',
      '{ "engines": { "node": 18 } }',
      '{ "engines": { "npm": ">=9" } }',
      '{ "engines": { "node": "" } }',
    ]) {
      assert.equal(parsePackageJson(text).nodeEngine, undefined, text);
    }
  });
});
