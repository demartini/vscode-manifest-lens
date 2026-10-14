import { isMap, isScalar, parseDocument } from "yaml";

import type { ParsedManifest } from "./types";
import { type YamlCollector, collectCatalogPair } from "./yaml-catalogs";

/**
 * Parses `.yarnrc.yml`. Yarn 4.10+ declares catalogs under `catalog` and `catalogs`; every
 * other key of this configuration file is unrelated and ignored.
 */
export function parseYarnrc(text: string): ParsedManifest {
  const document = parseDocument(text, { prettyErrors: false });
  const issues = document.errors.map((error) => error.message);
  const collector: YamlCollector = { declarations: [], sections: [], text };
  const root = document.contents;
  if (!isMap(root)) {
    if (text.trim() !== "") {
      issues.push("The Yarn configuration root is not a YAML mapping.");
    }
    return {
      declarations: [],
      format: "yarnrc",
      issues,
      sections: [],
      workspaces: [],
    };
  }
  for (const pair of root.items) {
    if (isScalar(pair.key)) {
      collectCatalogPair(collector, pair);
    }
  }
  return {
    declarations: collector.declarations,
    format: "yarnrc",
    issues,
    sections: collector.sections,
    workspaces: [],
  };
}
