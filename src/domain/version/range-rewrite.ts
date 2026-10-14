import semver from "semver";

/**
 * Rewrites for ranges that are more than one comparator: unions (`||`), hyphen ranges
 * and comparator sets. The rule everywhere is to widen the range just enough to admit the
 * target and to keep the user's spacing. A rewrite that does not admit the target is
 * never returned, whatever the input looked like.
 */

export interface ComplexRewriteOptions {
  /** Peer ranges are widened by appending an alternative instead of replacing one. */
  readonly appendAlternative: boolean;
  /** Rewrites one alternative that is a plain range (`^1.2.0`, `1.x`, ...). */
  readonly rewriteSimple: (
    alternative: string,
    version: string
  ) => string | undefined;
}

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const admits = (range: string, version: string): boolean =>
  semver.validRange(range) !== null &&
  semver.satisfies(version, range, { includePrerelease: true });

const tokensOf = (text: string): Token[] =>
  [...text.matchAll(/\S+/gu)].map((match) => ({
    end: match.index + match[0].length,
    start: match.index,
    text: match[0],
  }));

const replaceToken = (
  text: string,
  token: Token,
  replacement: string
): string =>
  `${text.slice(0, token.start)}${replacement}${text.slice(token.end)}`;

const COMPARATOR = /^(>=|<=|>|<)(\d+(?:\.\d+){0,2}(?:-[\w.-]+)?)$/u;

/** `<2`, `<2.0` and `<2.0.0` become `<N`, `<N.0` and `<N.0.0` for the next major above the target. */
const raisedUpperBound = (
  token: string,
  version: string
): string | undefined => {
  const match = COMPARATOR.exec(token);
  const operator = match?.[1];
  const bound = match?.[2];
  const target = semver.parse(version);
  if (operator === undefined || bound === undefined || target === null) {
    return undefined;
  }
  if (operator === "<=") {
    return `<=${version}`;
  }
  const parts = bound.split(".");
  const aligned = parts.slice(1).every((part) => part === "0");
  if (operator !== "<" || !aligned || bound.includes("-")) {
    return undefined;
  }
  return `<${[String(target.major + 1), ...parts.slice(1)].join(".")}`;
};

/** `>=1.0.0 <2.0.0`: every token a comparator, at most one upper bound, all lower bounds met. */
const rewriteComparators = (
  range: string,
  version: string
): string | undefined => {
  const tokens = tokensOf(range);
  const parsed = tokens.map((token) => COMPARATOR.exec(token.text));
  if (tokens.length < 2 || parsed.some((match) => match === null)) {
    return undefined;
  }
  const uppers = tokens.filter((token) => /^<=?/u.test(token.text));
  const lowers = tokens.filter((token) => /^>=?/u.test(token.text));
  const [upper] = uppers;
  if (
    uppers.length !== 1 ||
    upper === undefined ||
    !lowers.every((token) => admits(token.text, version))
  ) {
    return undefined;
  }
  const raised = raisedUpperBound(upper.text, version);
  return raised === undefined ? undefined : replaceToken(range, upper, raised);
};

/** `1.0.0 - 2.0.0`: only the upper bound moves. */
const rewriteHyphen = (range: string, version: string): string | undefined => {
  const match = /^(\S+)(\s+-\s+)(\S+)$/u.exec(range.trim());
  const lower = match?.[1];
  if (match === null || lower === undefined || !admits(`>=${lower}`, version)) {
    return undefined;
  }
  return range.replace(/(\s+-\s+)\S+$/u, `$1${version}`);
};

const rewriteAlternative = (
  alternative: string,
  version: string,
  options: ComplexRewriteOptions
): string | undefined =>
  options.rewriteSimple(alternative, version) ??
  rewriteComparators(alternative, version) ??
  rewriteHyphen(alternative, version);

const minimumOf = (alternative: string): semver.SemVer | null => {
  try {
    return semver.minVersion(alternative);
  } catch {
    return null;
  }
};

interface Alternative {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const alternativesOf = (range: string): Alternative[] => {
  const result: Alternative[] = [];
  let offset = 0;
  for (const part of range.split("||")) {
    const lead = part.length - part.trimStart().length;
    const text = part.trim();
    result.push({
      end: offset + lead + text.length,
      start: offset + lead,
      text,
    });
    offset += part.length + 2;
  }
  return result;
};

const newest = (
  alternatives: readonly Alternative[]
): Alternative | undefined => {
  let best: Alternative | undefined;
  let bestMinimum: semver.SemVer | null = null;
  for (const alternative of alternatives) {
    const minimum = minimumOf(alternative.text);
    if (
      minimum !== null &&
      (bestMinimum === null || semver.gt(minimum, bestMinimum))
    ) {
      best = alternative;
      bestMinimum = minimum;
    }
  }
  return best;
};

const rewriteUnion = (
  range: string,
  version: string,
  options: ComplexRewriteOptions
): string | undefined => {
  const alternatives = alternativesOf(range);
  const top = newest(alternatives);
  const topMinimum = top === undefined ? null : minimumOf(top.text);
  // Moving the newest alternative to a version below it would be a downgrade, not an update.
  if (
    top === undefined ||
    topMinimum === null ||
    !semver.gt(version, topMinimum) ||
    alternatives.some((alt) => admits(alt.text, version))
  ) {
    return undefined;
  }
  if (options.appendAlternative) {
    const separator = /\s*\|\|\s*/u.exec(range)?.[0] ?? " || ";
    const added = options.rewriteSimple(top.text, version) ?? `^${version}`;
    return `${range.trimEnd()}${separator}${added}`;
  }
  const rewritten = rewriteAlternative(top.text, version, options);
  return rewritten === undefined
    ? undefined
    : `${range.slice(0, top.start)}${rewritten}${range.slice(top.end)}`;
};

/** Rewrites a complex range so it admits `version`, or returns `undefined`. */
export function rewriteComplexRange(
  range: string,
  version: string,
  options: ComplexRewriteOptions
): string | undefined {
  if (admits(range, version)) {
    return undefined;
  }
  const result = range.includes("||")
    ? rewriteUnion(range, version, options)
    : (rewriteComparators(range, version) ?? rewriteHyphen(range, version));
  return result !== undefined && result !== range && admits(result, version)
    ? result
    : undefined;
}
