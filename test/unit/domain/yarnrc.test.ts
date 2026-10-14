import * as assert from "node:assert/strict";

import { createSpecifierEdit } from "../../../src/domain/manifest/edits";
import {
  manifestFormatOf,
  parseManifestText,
} from "../../../src/domain/manifest/parse";
import { parseYarnrc } from "../../../src/domain/manifest/yarnrc";

const YARNRC = `# Yarn configuration
nodeLinker: node-modules
npmRegistryServer: "https://registry.npmjs.org"

catalog:
  react: ^18.2.0
  "@scope/pkg": '~1.0.0'
  quoted: "2.0.0" # pinned

catalogs:
  react17:
    react: ^17.0.2
  testing:
    vitest: ^3.0.0

enableTelemetry: false
`;

describe("parseYarnrc", () => {
  const parsed = parseYarnrc(YARNRC);

  it("extracts the default catalog and the named catalogs", () => {
    assert.deepEqual(
      parsed.declarations.map(
        (d) => `${d.section}:${d.catalog ?? ""}:${d.name}=${d.specifier}`
      ),
      [
        "catalog::react=^18.2.0",
        "catalog::@scope/pkg=~1.0.0",
        "catalog::quoted=2.0.0",
        "catalog:react17:react=^17.0.2",
        "catalog:testing:vitest=^3.0.0",
      ]
    );
    assert.equal(parsed.format, "yarnrc");
    assert.deepEqual(parsed.workspaces, []);
    assert.deepEqual(parsed.issues, []);
  });

  it("describes each catalog as a section", () => {
    assert.deepEqual(
      parsed.sections.map((section) => section.id),
      ["catalog", "catalogs.react17", "catalogs.testing"]
    );
  });

  it("keeps the quoting of each value so edits stay valid YAML", () => {
    const replacement = (name: string) => {
      const declaration = parsed.declarations.find((d) => d.name === name);
      assert.ok(declaration, name);
      return createSpecifierEdit(declaration, ">=2.0.0").replacement;
    };
    assert.equal(replacement("react"), '">=2.0.0"');
    assert.equal(replacement("@scope/pkg"), "'>=2.0.0'");
    assert.equal(replacement("quoted"), '">=2.0.0"');
  });

  it("points the spans at the value text only, not at the comment after it", () => {
    const quoted = parsed.declarations.find((d) => d.name === "quoted");
    assert.ok(quoted);
    assert.equal(
      YARNRC.slice(quoted.valueSpan.start, quoted.valueSpan.end),
      '"2.0.0"'
    );
  });

  it("parses a file as Yarn 4.18.1 itself rewrites it (sorted keys, quotes dropped, extra settings)", () => {
    const written = [
      "approvedGitRepositories:",
      '  - "**"',
      "",
      "catalog:",
      "  left-pad: 1.3.0",
      "  react: ^18.2.0",
      "",
      "catalogs:",
      "  legacy:",
      "    zod: ~3.0.0",
      "",
      "enableScripts: true",
      "",
      "nodeLinker: node-modules",
      "",
      "npmMinimalAgeGate: 0",
      "",
    ].join("\n");
    const real = parseYarnrc(written);
    assert.deepEqual(
      real.declarations.map(
        (d) => `${d.catalog ?? ""}:${d.name}=${d.specifier}`
      ),
      [":left-pad=1.3.0", ":react=^18.2.0", "legacy:zod=~3.0.0"]
    );
    assert.deepEqual(real.issues, []);
  });

  it("ignores every key that is not a catalog, without reporting problems", () => {
    const other = parseYarnrc("nodeLinker: pnp\nenableGlobalCache: true\n");
    assert.deepEqual(other.declarations, []);
    assert.deepEqual(other.sections, []);
    assert.deepEqual(other.issues, []);
  });

  it("skips entries that are not package names or plain values", () => {
    const parsedBad = parseYarnrc(
      "catalog:\n  react: ^18\n  not a name: ^1\n  nested:\n    a: ^1\n  list:\n    - x\n"
    );
    assert.deepEqual(
      parsedBad.declarations.map((d) => d.name),
      ["react"]
    );
  });

  it("handles non-mapping, empty and malformed files", () => {
    assert.equal(parseYarnrc("- a\n- b").declarations.length, 0);
    assert.ok(parseYarnrc("- a\n- b").issues.length > 0);
    assert.deepEqual(parseYarnrc("").issues, []);
    assert.doesNotThrow(() => parseYarnrc("catalog: [unclosed"));
  });
});

describe("manifest format detection for .yarnrc.yml", () => {
  it("recognizes the file by name, at any depth", () => {
    assert.equal(manifestFormatOf("/repo/.yarnrc.yml"), "yarnrc");
    assert.equal(manifestFormatOf("C:\\repo\\.yarnrc.yml"), "yarnrc");
    assert.equal(manifestFormatOf("/repo/yarnrc.yml"), undefined);
    assert.equal(manifestFormatOf("/repo/.yarnrc"), undefined);
  });

  it("parses it through the shared entry point", () => {
    const parsed = parseManifestText(
      "/repo/.yarnrc.yml",
      "catalog:\n  react: ^18.0.0\n"
    );
    assert.equal(parsed?.format, "yarnrc");
    assert.equal(parsed?.declarations.length, 1);
  });
});
