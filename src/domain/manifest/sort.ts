import { parseTree } from "jsonc-parser";
import type { Node } from "jsonc-parser";

import type { ManifestEdit } from "./types";

const SORTABLE = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);
const SEPARATOR = /^[\s,]*$/u;

export interface SortResult {
  readonly edits: readonly ManifestEdit[];
  /** Sections that were left untouched because sorting could lose comments. */
  readonly skipped: readonly string[];
}

const sortSection = (
  text: string,
  name: string,
  object: Node
): { edit?: ManifestEdit; skipped?: string } => {
  const properties = (object.children ?? []).filter(
    (property) => typeof property.children?.[0]?.value === "string"
  );
  if (properties.length < 2) {
    return {};
  }
  const chunks = properties.map((property) => ({
    key: String(property.children?.[0]?.value),
    text: text.slice(property.offset, property.offset + property.length),
  }));
  const separators: string[] = [];
  for (let index = 0; index < properties.length - 1; index += 1) {
    const current = properties[index];
    const next = properties[index + 1];
    if (!(current && next)) {
      continue;
    }
    const gap = text.slice(current.offset + current.length, next.offset);
    if (!SEPARATOR.test(gap)) {
      return { skipped: name };
    }
    separators.push(gap);
  }
  const sorted = chunks.toSorted((a, b) => a.key.localeCompare(b.key, "en"));
  if (sorted.every((chunk, index) => chunk.key === chunks[index]?.key)) {
    return {};
  }
  const [first] = properties;
  const last = properties.at(-1);
  if (!(first && last)) {
    return {};
  }
  const replacement = sorted
    .map((chunk, index) => chunk.text + (separators[index] ?? ""))
    .join("");
  const start = first.offset;
  const end = last.offset + last.length;
  return {
    edit: {
      declarationId: name,
      expected: text.slice(start, end),
      replacement,
      span: { end, start },
    },
  };
};

/** Computes edits that alphabetize dependency sections without touching anything else. */
export function computeSortEdits(text: string): SortResult {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const edits: ManifestEdit[] = [];
  const skipped: string[] = [];
  if (root?.type !== "object") {
    return { edits, skipped };
  }
  for (const property of root.children ?? []) {
    const name = String(property.children?.[0]?.value);
    const value = property.children?.[1];
    if (SORTABLE.has(name) && value?.type === "object") {
      const result = sortSection(text, name, value);
      if (result.edit) {
        edits.push(result.edit);
      }
      if (result.skipped !== undefined) {
        skipped.push(result.skipped);
      }
    }
  }
  return { edits, skipped };
}
