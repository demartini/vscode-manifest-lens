import { isMap, isScalar } from "yaml";
import type { Pair, Scalar } from "yaml";

import { isValidPackageName } from "./package-name";
import type {
  DependencyDeclaration,
  DependencySection,
  QuoteStyle,
  SectionInfo,
} from "./types";

export interface YamlCollector {
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

export const collectYamlMap = (
  collector: YamlCollector,
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

/**
 * Collects the `catalog` and `catalogs` entries that pnpm and Yarn declare the same way.
 * Returns whether the pair was one of those keys.
 */
export function collectCatalogPair(
  collector: YamlCollector,
  pair: Pair
): boolean {
  if (!isScalar(pair.key)) {
    return false;
  }
  const resolveName = (key: string): string | undefined =>
    isValidPackageName(key) ? key : undefined;
  if (pair.key.value === "catalog") {
    collectYamlMap(collector, pair, {
      catalog: "",
      direct: true,
      idPrefix: "catalog",
      resolveName,
      section: "catalog",
    });
    return true;
  }
  if (pair.key.value === "catalogs" && isMap(pair.value)) {
    for (const named of pair.value.items) {
      if (isScalar(named.key)) {
        const catalog = String(named.key.value);
        collectYamlMap(collector, named, {
          catalog,
          direct: true,
          idPrefix: `catalogs.${catalog}`,
          resolveName,
          section: "catalog",
        });
      }
    }
    return true;
  }
  return false;
}
