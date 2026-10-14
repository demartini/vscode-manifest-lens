import { isMap, isScalar, parseDocument } from "yaml";

import { overrideTargetName } from "./package-name";
import type { ParsedManifest } from "./types";
import {
  type YamlCollector,
  collectCatalogPair,
  collectYamlMap,
} from "./yaml-catalogs";

const packageGlobs = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** Parses `pnpm-workspace.yaml`, extracting catalogs, overrides and package globs. */
export function parsePnpmWorkspace(text: string): ParsedManifest {
  const document = parseDocument(text, { prettyErrors: false });
  const issues = document.errors.map((error) => error.message);
  const collector: YamlCollector = { declarations: [], sections: [], text };
  const root = document.contents;
  if (!isMap(root)) {
    if (text.trim() !== "") {
      issues.push("The workspace file root is not a YAML mapping.");
    }
    return {
      declarations: [],
      format: "pnpm-workspace",
      issues,
      sections: [],
      workspaces: [],
    };
  }
  for (const pair of root.items) {
    if (!isScalar(pair.key) || collectCatalogPair(collector, pair)) {
      continue;
    }
    if (pair.key.value === "overrides") {
      collectYamlMap(collector, pair, {
        direct: false,
        idPrefix: "overrides",
        resolveName: overrideTargetName,
        section: "overrides",
      });
    }
  }
  const json: unknown = document.toJS();
  const packages =
    typeof json === "object" && json !== null && "packages" in json
      ? packageGlobs(json.packages)
      : [];
  return {
    declarations: collector.declarations,
    format: "pnpm-workspace",
    issues,
    sections: collector.sections,
    workspaces: packages,
  };
}
