import { parse } from "yaml";

/** What a package manager's own configuration says about not installing fresh releases. */
export interface ManagerReleaseAge {
  readonly minimumMinutes: number;
  /** Packages exempt from the minimum: names, `*` globs and `name@version || version`. */
  readonly exclude: readonly string[];
}

const MINUTES_PER_DAY = 1440;
const MINUTES = 60;

const policyOf = (
  minutes: number,
  exclude: readonly string[]
): ManagerReleaseAge | undefined =>
  Number.isFinite(minutes) && minutes > 0
    ? { exclude, minimumMinutes: Math.ceil(minutes) }
    : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/** `minimumReleaseAge` (minutes) and `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. */
export function parsePnpmReleaseAge(
  text: string
): ManagerReleaseAge | undefined {
  let document: unknown;
  try {
    document = parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(document)) {
    return undefined;
  }
  const { minimumReleaseAge } = document;
  return typeof minimumReleaseAge === "number"
    ? policyOf(minimumReleaseAge, stringsOf(document.minimumReleaseAgeExclude))
    : undefined;
}

/** `min-release-age` (days) in an `.npmrc`; npm has no exclusion list. */
export function parseNpmReleaseAge(
  text: string
): ManagerReleaseAge | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals > 0 && trimmed.slice(0, equals).trim() === "min-release-age") {
      const days = Number(trimmed.slice(equals + 1).trim());
      return Number.isNaN(days)
        ? undefined
        : policyOf(days * MINUTES_PER_DAY, []);
    }
  }
  return undefined;
}

const YARN_UNIT_MINUTES: Readonly<Record<string, number>> = {
  d: 1440,
  h: 60,
  m: 1,
  s: 1 / 60,
  w: 10_080,
};

/**
 * Yarn's duration grammar as Yarn 4.18.1 accepts it: a number of minutes, or one number
 * followed by `s`, `m`, `h`, `d` or `w`. Compound values ("1d12h") and words are rejected by Yarn.
 */
const yarnDurationMinutes = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value;
  }
  const match =
    typeof value === "string"
      ? /^(\d+(?:\.\d+)?)([smhdw])?$/u.exec(value)
      : null;
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Number(match[1]) * (YARN_UNIT_MINUTES[match[2] ?? "m"] ?? 1);
};

/**
 * `npmMinimalAgeGate` and `npmPreapprovedPackages` in `.yarnrc.yml`. A preapproved
 * descriptor (`name@npm:^4`) is dropped: keeping the package gated is the safe direction.
 */
export function parseYarnReleaseAge(
  text: string
): ManagerReleaseAge | undefined {
  let document: unknown;
  try {
    document = parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(document)) {
    return undefined;
  }
  const minutes = yarnDurationMinutes(document.npmMinimalAgeGate);
  const preapproved = stringsOf(document.npmPreapprovedPackages).filter(
    (entry) => !entry.slice(1).includes("@")
  );
  return minutes === undefined ? undefined : policyOf(minutes, preapproved);
}

/** Removes a trailing `#` comment, leaving `#` inside quotes alone. */
const stripTomlComment = (line: string): string => {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
};

/** Open brackets minus closed ones, ignoring any that sit inside quotes. */
const bracketBalance = (text: string): number => {
  let depth = 0;
  let quote: string | undefined;
  for (const char of text.split("")) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
    }
  }
  return depth;
};

/** The assignments under `[install]`; the only table Bun reads these keys from. */
const bunInstallValues = (text: string): Map<string, string> => {
  const values = new Map<string, string>();
  const lines = text.split(/\r?\n/u).map(stripTomlComment);
  let inInstall = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    const table = /^\[([^[\]]+)\]$/u.exec(line);
    if (table) {
      inInstall = table[1]?.trim() === "install";
      continue;
    }
    const equals = line.indexOf("=");
    if (!inInstall || equals < 1) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    while (
      value.startsWith("[") &&
      bracketBalance(value) > 0 &&
      index + 1 < lines.length
    ) {
      index += 1;
      value += ` ${(lines[index] ?? "").trim()}`;
    }
    values.set(key, value);
  }
  return values;
};

/** `minimumReleaseAge` (seconds) and `minimumReleaseAgeExcludes` under `[install]` in `bunfig.toml`. */
export function parseBunReleaseAge(
  text: string
): ManagerReleaseAge | undefined {
  const values = bunInstallValues(text);
  const age = values.get("minimumReleaseAge");
  if (age === undefined || !/^-?\d[\d_]*$/u.test(age)) {
    return undefined;
  }
  const excludes = [
    ...(values.get("minimumReleaseAgeExcludes") ?? "").matchAll(
      /"([^"]*)"|'([^']*)'/gu
    ),
  ].map((match) => match[1] ?? match[2] ?? "");
  return policyOf(Number(age.replaceAll("_", "")) / MINUTES, excludes);
}

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
      .join(".*")}$`,
    "u"
  );

/** Whether an exclusion list exempts `name@version` from the minimum release age. */
export function isExcludedFromReleaseAge(
  exclude: readonly string[],
  name: string,
  version: string
): boolean {
  return exclude.some((entry) => {
    const at = entry.lastIndexOf("@");
    if (at <= 0) {
      return globToRegExp(entry.trim()).test(name);
    }
    const versions = entry
      .slice(at + 1)
      .split("||")
      .map((candidate) => candidate.trim());
    return (
      globToRegExp(entry.slice(0, at).trim()).test(name) &&
      versions.includes(version)
    );
  });
}
