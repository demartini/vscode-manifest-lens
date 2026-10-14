import semver from "semver";

import { classifyUpdate, isPotentiallyBreaking } from "./classification";
import type { UpdateSeverity } from "./classification";
import { minimumVersion, satisfiesSpecifier, unwrapAlias } from "./specifier";
import type { ParsedSpecifier } from "./specifier";

export interface ReleaseInfo {
  readonly version: string;
  readonly publishedAt?: string;
  readonly deprecated?: string;
}

export interface Candidate {
  readonly version: string;
  readonly severity: UpdateSeverity;
  readonly potentiallyBreaking: boolean;
  readonly publishedAt?: string;
}

export interface PrereleasePolicy {
  readonly enabled: boolean;
  /** Restricts prerelease suggestions to these identifiers; empty means any. */
  readonly tags: readonly string[];
}

export interface VersionSelectionInput {
  readonly specifier: ParsedSpecifier;
  readonly releases: readonly ReleaseInfo[];
  readonly distTags: Readonly<Record<string, string>>;
  readonly installedVersion?: string;
  readonly prerelease: PrereleasePolicy;
}

export interface VersionSelection {
  /** The version updates are measured from. */
  readonly baseVersion?: string;
  readonly latestPublished?: string;
  /** Newest stable release that the current specifier admits. */
  readonly latestSatisfying?: string;
  /** Newest stable release above the base version. */
  readonly target?: Candidate;
  readonly major?: Candidate;
  readonly minor?: Candidate;
  readonly patch?: Candidate;
  readonly prerelease?: Candidate;
  /** Every stable candidate above the base, newest first. */
  readonly stableCandidates: readonly Candidate[];
}

const byVersionDesc = (a: ReleaseInfo, b: ReleaseInfo): number =>
  semver.rcompare(a.version, b.version);

const toCandidate = (base: string, release: ReleaseInfo): Candidate => ({
  potentiallyBreaking: isPotentiallyBreaking(base, release.version),
  severity: classifyUpdate(base, release.version),
  ...(release.publishedAt === undefined
    ? {}
    : { publishedAt: release.publishedAt }),
  version: release.version,
});

const chooseBase = (
  spec: ParsedSpecifier,
  installed: string | undefined
): string | undefined => {
  if (
    installed !== undefined &&
    semver.valid(installed) !== null &&
    satisfiesSpecifier(spec, installed)
  ) {
    return installed;
  }
  return minimumVersion(spec);
};

const matchesPrereleaseTag = (
  version: string,
  tags: readonly string[]
): boolean => {
  if (tags.length === 0) {
    return true;
  }
  const id = semver.prerelease(version)?.[0];
  return id !== undefined && tags.includes(String(id));
};

const latestPublishedOf = (
  valid: readonly ReleaseInfo[],
  distTags: Readonly<Record<string, string>>
): string | undefined => {
  const tagged = distTags.latest;
  if (
    tagged !== undefined &&
    valid.some((release) => release.version === tagged)
  ) {
    return tagged;
  }
  const stable = valid.find(
    (release) => semver.prerelease(release.version) === null
  );
  return (stable ?? valid[0])?.version;
};

/** Selects the update candidates for a declaration from registry release data. */
export function selectVersions(input: VersionSelectionInput): VersionSelection {
  const spec = unwrapAlias(input.specifier);
  const valid = input.releases
    .filter((release) => semver.valid(release.version) !== null)
    .toSorted(byVersionDesc);
  const stable = valid.filter(
    (release) => semver.prerelease(release.version) === null
  );
  const notDeprecated = stable.filter(
    (release) => release.deprecated === undefined
  );
  const pool = notDeprecated.length > 0 ? notDeprecated : stable;

  const baseVersion = chooseBase(spec, input.installedVersion);
  const latestPublished = latestPublishedOf(valid, input.distTags);
  const latestSatisfying = stable.find((release) =>
    satisfiesSpecifier(spec, release.version)
  )?.version;

  if (baseVersion === undefined) {
    return { latestPublished, latestSatisfying, stableCandidates: [] };
  }

  const base = semver.parse(baseVersion);
  const stableCandidates = pool
    .filter((release) => semver.gt(release.version, baseVersion))
    .map((release) => toCandidate(baseVersion, release));
  const firstWhere = (
    predicate: (version: semver.SemVer) => boolean
  ): Candidate | undefined =>
    stableCandidates.find((candidate) => {
      const parsed = semver.parse(candidate.version);
      return parsed !== null && predicate(parsed);
    });

  // A prerelease is only suggested when it is newer than every stable option.
  const threshold = stableCandidates[0]?.version ?? baseVersion;
  const prereleaseRelease = input.prerelease.enabled
    ? valid.find(
        (release) =>
          semver.prerelease(release.version) !== null &&
          semver.gt(release.version, threshold) &&
          matchesPrereleaseTag(release.version, input.prerelease.tags)
      )
    : undefined;
  const prerelease = prereleaseRelease
    ? toCandidate(baseVersion, prereleaseRelease)
    : undefined;

  return {
    baseVersion,
    latestPublished,
    latestSatisfying,
    major: base ? firstWhere((v) => v.major > base.major) : undefined,
    minor: base
      ? firstWhere((v) => v.major === base.major && v.minor > base.minor)
      : undefined,
    patch: base
      ? firstWhere(
          (v) =>
            v.major === base.major &&
            v.minor === base.minor &&
            v.patch > base.patch
        )
      : undefined,
    prerelease,
    stableCandidates,
    target: stableCandidates[0],
  };
}
