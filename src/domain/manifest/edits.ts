import { ManifestLensError } from "../../shared/errors";
import { err, ok } from "../../shared/result";
import type { Result } from "../../shared/result";
import type {
  DependencyDeclaration,
  ManifestEdit,
  ParsedManifest,
  QuoteStyle,
} from "./types";

const PLAIN_YAML = /^[\w^~][\w.^~+-]*$/u;

/** Renders a specifier as a token that is valid for the source file's syntax. */
export const renderSpecifierToken = (
  quote: QuoteStyle,
  specifier: string
): string => {
  switch (quote) {
    case "json":
    case "yaml-double": {
      return JSON.stringify(specifier);
    }
    case "yaml-single": {
      return `'${specifier.replaceAll("'", "''")}'`;
    }
    case "yaml-plain": {
      return PLAIN_YAML.test(specifier) ? specifier : JSON.stringify(specifier);
    }
    default: {
      return JSON.stringify(specifier);
    }
  }
};

export const createSpecifierEdit = (
  declaration: DependencyDeclaration,
  specifier: string
): ManifestEdit => ({
  declarationId: declaration.id,
  expected: declaration.rawValue,
  replacement: renderSpecifierToken(declaration.quote, specifier),
  span: declaration.valueSpan,
});

/** Finds the declaration in freshly parsed text that still matches the analyzed one. */
export const relocateDeclaration = (
  analyzed: DependencyDeclaration,
  fresh: ParsedManifest
): DependencyDeclaration | undefined => {
  const match = fresh.declarations.find(
    (candidate) => candidate.id === analyzed.id
  );
  return match?.specifier === analyzed.specifier && match.name === analyzed.name
    ? match
    : undefined;
};

/**
 * Applies non-overlapping edits to `text`. Every edit must find the text it
 * expects at its span; otherwise the document changed since analysis and the
 * whole batch is rejected rather than risking overwriting the user's work.
 */
export function applyManifestEdits(
  text: string,
  edits: readonly ManifestEdit[]
): Result<string, ManifestLensError> {
  const ordered = edits.toSorted((a, b) => a.span.start - b.span.start);
  let previousEnd = -1;
  for (const edit of ordered) {
    const { start, end } = edit.span;
    if (start < previousEnd || start < 0 || end > text.length || start > end) {
      return err(
        new ManifestLensError(
          "stale",
          "The edits overlap or fall outside the document."
        )
      );
    }
    if (text.slice(start, end) !== edit.expected) {
      return err(
        new ManifestLensError(
          "stale",
          "The manifest changed since it was analyzed. Re-run the analysis and try again."
        )
      );
    }
    previousEnd = end;
  }
  let result = text;
  for (const edit of ordered.toReversed()) {
    result =
      result.slice(0, edit.span.start) +
      edit.replacement +
      result.slice(edit.span.end);
  }
  return ok(result);
}
