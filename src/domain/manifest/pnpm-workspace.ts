import { isMap, isScalar, parseDocument } from "yaml";
import type { Pair, Scalar } from "yaml";

import { isValidPackageName, overrideTargetName } from "./package-name";
import type {
  DependencyDeclaration,
  DependencySection,
  ParsedManifest,
  QuoteStyle,
  SectionInfo,
} from "./types";

interface Collector {
  readonly text: string;
  readonly declarations: DependencyDeclaration[];
  readonly sections: SectionInfo[];
}

const quoteStyleOf = (scalar: Scalar): QuoteStyle => {
  if (scalar.type === "QUOTE_DOUBLE") {
    return "yaml-double";
  }
  if (scalar.type === "QUOTE_SINGLE") {
    return "yaml-single";
  }
  return "yaml-plain";
};

const rangeOf = (
  scalar: Scalar
): { start: number; end: number } | undefined => {
  const { range } = scalar;
  return range ? { end: range[1], start: range[0] } : undefined;
};

const collectMap = (
  collector: Collector,
  pair: Pair,
  options: {
    section: DependencySection;
    catalog?: string;
    idPrefix: string;
    direct: boolean;
    resolveName: (key: string) => string | undefined;
  }
): void => {
  if (!(isScalar(pair.key) && isMap(pair.value))) {
    return;
  }
  const keySpan = rangeOf(pair.key);
  if (!keySpan) {
    return;
  }
  const ids: string[] = [];
  for (const entry of pair.value.items) {
    if (!(isScalar(entry.key) && isScalar(entry.value))) {
      continue;
    }
    const key = String(entry.key.value);
    const name = options.resolveName(key);
    const nameSpan = rangeOf(entry.key);
    const valueSpan = rangeOf(entry.value);
    const { value } = entry.value;
    if (
      name === undefined ||
      !nameSpan ||
      !valueSpan ||
      (typeof value !== "string" && typeof value !== "number")
    ) {
      continue;
    }
    const id = `${options.idPrefix}/${key}`;
    ids.push(id);
    collector.declarations.push({
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      direct: options.direct,
      id,
      name,
      nameSpan,
      quote: quoteStyleOf(entry.value),
      rawValue: collector.text.slice(valueSpan.start, valueSpan.end),
      section: options.section,
      specifier: String(value),
      valueSpan,
    });
  }
  collector.sections.push({
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    declarationIds: ids,
    id: options.idPrefix,
    keySpan,
    section: options.section,
  });
};

const packageGlobs = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** Parses `pnpm-workspace.yaml`, extracting catalogs, overrides and package globs. */
export function parsePnpmWorkspace(text: string): ParsedManifest {
  const document = parseDocument(text, { prettyErrors: false });
  const issues = document.errors.map((error) => error.message);
  const collector: Collector = { declarations: [], sections: [], text };
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
    if (!isScalar(pair.key)) {
      continue;
    }
    if (pair.key.value === "catalog") {
      collectMap(collector, pair, {
        catalog: "",
        direct: true,
        idPrefix: "catalog",
        resolveName: (key) => (isValidPackageName(key) ? key : undefined),
        section: "catalog",
      });
    } else if (pair.key.value === "overrides") {
      collectMap(collector, pair, {
        direct: false,
        idPrefix: "overrides",
        resolveName: overrideTargetName,
        section: "overrides",
      });
    } else if (pair.key.value === "catalogs" && isMap(pair.value)) {
      for (const named of pair.value.items) {
        if (isScalar(named.key)) {
          const catalog = String(named.key.value);
          collectMap(collector, named, {
            catalog,
            direct: true,
            idPrefix: `catalogs.${catalog}`,
            resolveName: (key) => (isValidPackageName(key) ? key : undefined),
            section: "catalog",
          });
        }
      }
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
