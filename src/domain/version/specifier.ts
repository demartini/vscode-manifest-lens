import semver from "semver";

import type { DependencySection } from "../manifest/types";
import { rewriteComplexRange } from "./range-rewrite";

export type RangeOperator = "" | "<" | "<=" | "=" | ">" | ">=" | "^" | "~";

/** The structured form of a dependency specifier as written in a manifest. */
export type ParsedSpecifier =
  | {
      readonly kind: "range";
      readonly raw: string;
      readonly operator: RangeOperator;
      readonly version: string;
    }
  | {
      readonly kind: "partial";
      readonly raw: string;
      readonly operator: "" | "^" | "~";
      readonly segments: readonly string[];
    }
  | { readonly kind: "complex"; readonly raw: string }
  | { readonly kind: "tag"; readonly raw: string; readonly tag: string }
  | {
      readonly kind: "alias";
      readonly raw: string;
      readonly target: string;
      readonly inner: ParsedSpecifier;
    }
  | { readonly kind: "catalog"; readonly raw: string; readonly catalog: string }
  | { readonly kind: "workspace"; readonly raw: string }
  | {
      readonly kind: "local";
      readonly raw: string;
      readonly protocol: string;
    }
  | {
      readonly kind: "remote";
      readonly raw: string;
      readonly protocol: string;
    }
  | { readonly kind: "invalid"; readonly raw: string };

const FULL_RANGE =
  /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;
const PARTIAL_RANGE =
  /^(\^|~)?\s*([\d*xX]+)(?:\.([\d*xX]+))?(?:\.([\d*xX]+))?$/u;
const TAG = /^[A-Za-z][\w.-]*$/u;
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+(?:#.*)?$/u;
const LOCAL_PROTOCOLS = new Set(["file", "link", "portal"]);
const REMOTE_PROTOCOLS = new Set([
  "bitbucket",
  "git",
  "git+file",
  "git+http",
  "git+https",
  "git+ssh",
  "github",
  "gitlab",
  "http",
  "https",
  "jsr",
  "patch",
]);
const WILDCARD = /^[*xX]$/u;

const OPERATORS: readonly RangeOperator[] = [
  "",
  "<",
  "<=",
  "=",
  ">",
  ">=",
  "^",
  "~",
];
const isRangeOperator = (value: string): value is RangeOperator =>
  (OPERATORS as readonly string[]).includes(value);
const toRangeOperator = (value: string): RangeOperator =>
  isRangeOperator(value) ? value : "";
const toLooseOperator = (value: string): "" | "^" | "~" =>
  value === "^" || value === "~" ? value : "";

const parseAlias = (raw: string): ParsedSpecifier => {
  const rest = raw.slice("npm:".length);
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    const inner = parseSpecifier(rest.slice(at + 1));
    if (inner.kind === "alias") {
      return { kind: "invalid", raw };
    }
    return { inner, kind: "alias", raw, target: rest.slice(0, at) };
  }
  return {
    inner: { kind: "tag", raw: "latest", tag: "latest" },
    kind: "alias",
    raw,
    target: rest,
  };
};

const parseProtocol = (raw: string): ParsedSpecifier | undefined => {
  if (raw.startsWith("npm:")) {
    return parseAlias(raw);
  }
  if (raw.startsWith("workspace:")) {
    return { kind: "workspace", raw };
  }
  if (raw.startsWith("catalog:")) {
    const name = raw.slice("catalog:".length).trim();
    return {
      catalog: name === "" || name === "default" ? "" : name,
      kind: "catalog",
      raw,
    };
  }
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const protocol = raw.slice(0, colon);
    if (LOCAL_PROTOCOLS.has(protocol)) {
      return { kind: "local", protocol, raw };
    }
    if (REMOTE_PROTOCOLS.has(protocol)) {
      return { kind: "remote", protocol, raw };
    }
  }
  if (GITHUB_SHORTHAND.test(raw)) {
    return { kind: "remote", protocol: "github", raw };
  }
  return undefined;
};

/** Parses a manifest specifier. Never throws; unknown shapes become `invalid`. */
export function parseSpecifier(input: string): ParsedSpecifier {
  const raw = input.trim();
  const protocol = parseProtocol(raw);
  if (protocol) {
    return protocol;
  }
  const full = FULL_RANGE.exec(raw);
  if (full?.[2] !== undefined && semver.valid(full[2]) !== null) {
    return {
      kind: "range",
      operator: toRangeOperator(full[1] ?? ""),
      raw,
      version: full[2],
    };
  }
  const partial = PARTIAL_RANGE.exec(raw);
  if (partial) {
    const segments = [partial[2], partial[3], partial[4]].filter(
      (segment): segment is string => segment !== undefined
    );
    return {
      kind: "partial",
      operator: toLooseOperator(partial[1] ?? ""),
      raw,
      segments,
    };
  }
  if (raw === "") {
    return { kind: "partial", operator: "", raw, segments: ["*"] };
  }
  if (semver.validRange(raw) !== null) {
    return { kind: "complex", raw };
  }
  if (TAG.test(raw)) {
    return { kind: "tag", raw, tag: raw };
  }
  return { kind: "invalid", raw };
}

/** Returns the registry specifier that governs version selection (alias-aware). */
export const unwrapAlias = (spec: ParsedSpecifier): ParsedSpecifier =>
  spec.kind === "alias" ? spec.inner : spec;

/** The registry package name for a declaration (the alias target when aliased). */
export const registryName = (
  declaredName: string,
  spec: ParsedSpecifier
): string => (spec.kind === "alias" ? spec.target : declaredName);

/** The lowest version the specifier admits, if it can be determined. */
export const minimumVersion = (spec: ParsedSpecifier): string | undefined => {
  const effective = unwrapAlias(spec);
  switch (effective.kind) {
    case "range":
    case "partial":
    case "complex": {
      if (
        effective.kind === "range" &&
        effective.operator !== ">" &&
        effective.operator !== "<"
      ) {
        return semver.valid(effective.version) ?? undefined;
      }
      try {
        return semver.minVersion(effective.raw)?.version;
      } catch {
        return undefined;
      }
    }
    default: {
      return undefined;
    }
  }
};

/** Whether a concrete version satisfies the specifier. */
export const satisfiesSpecifier = (
  spec: ParsedSpecifier,
  version: string
): boolean => {
  const effective = unwrapAlias(spec);
  if (
    effective.kind !== "range" &&
    effective.kind !== "partial" &&
    effective.kind !== "complex"
  ) {
    return false;
  }
  return semver.satisfies(version, effective.raw === "" ? "*" : effective.raw);
};

const rewritePartial = (
  spec: Extract<ParsedSpecifier, { kind: "partial" }>,
  version: string
): string | undefined => {
  const parsed = semver.parse(version);
  if (!parsed) {
    return undefined;
  }
  const parts = [parsed.major, parsed.minor, parsed.patch];
  const segments = spec.segments.map((segment, index) =>
    WILDCARD.test(segment) ? segment : String(parts[index])
  );
  const rewritten = `${spec.operator}${segments.join(".")}`;
  return rewritten === spec.raw ? undefined : rewritten;
};

export interface RewriteOptions {
  /** The section the declaration lives in: peer ranges are widened, not replaced. */
  readonly section?: DependencySection;
}

/**
 * Produces a new specifier that targets `version` while preserving the user's
 * range convention. Returns `undefined` when no valid rewrite exists (tags,
 * protocols, complex ranges, upper bounds) or when nothing would change.
 */
export function rewriteSpecifier(
  spec: ParsedSpecifier,
  version: string,
  options: RewriteOptions = {}
): string | undefined {
  if (semver.valid(version) === null) {
    return undefined;
  }
  switch (spec.kind) {
    case "range": {
      if (spec.operator === "<" || spec.operator === "<=") {
        return undefined;
      }
      const rewritten = `${spec.operator}${version}`;
      return rewritten === spec.raw ? undefined : rewritten;
    }
    case "partial": {
      return rewritePartial(spec, version);
    }
    case "complex": {
      return rewriteComplexRange(spec.raw, version, {
        appendAlternative: options.section === "peerDependencies",
        rewriteSimple: (alternative, target) => {
          const simple = parseSpecifier(alternative);
          return simple.kind === "range" || simple.kind === "partial"
            ? rewriteSpecifier(simple, target)
            : undefined;
        },
      });
    }
    case "alias": {
      const aliased = spec.inner.kind;
      if (
        aliased !== "range" &&
        aliased !== "partial" &&
        aliased !== "complex"
      ) {
        return undefined;
      }
      const inner = rewriteSpecifier(spec.inner, version, options);
      return inner === undefined ? undefined : `npm:${spec.target}@${inner}`;
    }
    default: {
      return undefined;
    }
  }
}

/** Whether the specifier refers to something resolvable through the registry. */
export const isRegistryResolvable = (spec: ParsedSpecifier): boolean => {
  const effective = unwrapAlias(spec);
  return (
    effective.kind === "range" ||
    effective.kind === "partial" ||
    effective.kind === "complex" ||
    effective.kind === "tag"
  );
};
