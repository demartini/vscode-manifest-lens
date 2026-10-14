import semver from "semver";

export type UpdateSeverity =
  | "major"
  | "minor"
  | "patch"
  | "prerelease"
  | "unknown";

/**
 * Classifies the distance between two versions.
 *
 * `0.x` releases are classified literally (0.3.0 → 0.4.0 is `minor`); use
 * {@link isPotentiallyBreaking} to flag the changes that semver convention
 * treats as breaking for initial-development versions.
 */
export function classifyUpdate(from: string, to: string): UpdateSeverity {
  const a = semver.parse(from);
  const b = semver.parse(to);
  if (!(a && b)) {
    return "unknown";
  }
  if (b.prerelease.length > 0) {
    return "prerelease";
  }
  if (a.major !== b.major) {
    return "major";
  }
  if (a.minor !== b.minor) {
    return "minor";
  }
  return "patch";
}

/** Whether moving between the versions may break consumers by semver convention. */
export function isPotentiallyBreaking(from: string, to: string): boolean {
  const a = semver.parse(from);
  const b = semver.parse(to);
  if (!(a && b) || semver.gte(a, b)) {
    return false;
  }
  if (a.major !== b.major) {
    return true;
  }
  if (a.major === 0) {
    return a.minor !== b.minor || (a.minor === 0 && a.patch !== b.patch);
  }
  return false;
}

export const isPrerelease = (version: string): boolean => {
  const parsed = semver.parse(version);
  return parsed !== null && parsed.prerelease.length > 0;
};
