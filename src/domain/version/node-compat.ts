import semver from "semver";

export type NodeCompatibility = "compatible" | "incompatible" | "unknown";

/**
 * Whether a dependency release runs on every Node version the project declares. The
 * project's range must sit inside the release's range: a project that promises Node 18
 * cannot depend on something that needs Node 20. Missing or unparsable ranges are unknown.
 */
export function nodeCompatibility(
  projectRange: string | undefined,
  releaseRange: string | undefined
): NodeCompatibility {
  if (
    projectRange === undefined ||
    releaseRange === undefined ||
    projectRange.trim() === "" ||
    releaseRange.trim() === "" ||
    semver.validRange(projectRange) === null ||
    semver.validRange(releaseRange) === null
  ) {
    return "unknown";
  }
  return semver.subset(projectRange, releaseRange)
    ? "compatible"
    : "incompatible";
}
