import semver from "semver";

import type {
  PeerAnalysis,
  PeerConflict,
  PeerPackageInfo,
  PeerRelease,
  PeerResolution,
} from "./types";

export interface PeerAnalysisInput {
  readonly subject: string;
  readonly candidate: {
    readonly version: string;
    readonly peerDependencies: Readonly<Record<string, string>>;
    readonly optionalPeers: readonly string[];
  };
  /** Packages that may constrain the subject through their own peer ranges. */
  readonly dependents: readonly PeerPackageInfo[];
  /** The installed (or declared) version of a package, if known. */
  readonly versionOf: (name: string) => string | undefined;
  /** Releases of a dependent newer than the one in use, newest first. */
  readonly newerReleasesOf: (name: string) => readonly PeerRelease[];
  /** True when data for some relevant package could not be gathered. */
  readonly incomplete: boolean;
}

const satisfiesPeer = (version: string, range: string): boolean | undefined => {
  if (semver.validRange(range) === null) {
    return undefined;
  }
  return semver.satisfies(version, range, { includePrerelease: true });
};

const findResolution = (
  dependent: PeerPackageInfo,
  subject: string,
  candidate: string,
  releases: readonly PeerRelease[]
): PeerResolution | undefined => {
  for (const release of releases) {
    if (semver.lte(release.version, dependent.version)) {
      continue;
    }
    const range = release.peerDependencies[subject];
    if (range === undefined || satisfiesPeer(candidate, range) === true) {
      return { package: dependent.name, version: release.version };
    }
  }
  return undefined;
};

const dependentConflicts = (input: PeerAnalysisInput): PeerConflict[] => {
  const conflicts: PeerConflict[] = [];
  for (const dependent of input.dependents) {
    const range = dependent.peerDependencies[input.subject];
    if (range === undefined) {
      continue;
    }
    const verdict = satisfiesPeer(input.candidate.version, range);
    if (verdict === true) {
      continue;
    }
    const optional = dependent.optionalPeers.includes(input.subject);
    const resolution =
      verdict === false
        ? findResolution(
            dependent,
            input.subject,
            input.candidate.version,
            input.newerReleasesOf(dependent.name)
          )
        : undefined;
    conflicts.push({
      blocker: dependent.name,
      blockerVersion: dependent.version,
      candidateVersion: input.candidate.version,
      confidence: verdict === false && !optional ? "confirmed" : "potential",
      direction: "blocker-restricts-candidate",
      evidence: dependent.source,
      note:
        verdict === undefined
          ? `${dependent.name}@${dependent.version} declares a peer range for ${input.subject} that cannot be evaluated.`
          : `${dependent.name}@${dependent.version} requires ${input.subject}@${range}${optional ? " (optional peer)" : ""}.`,
      optional,
      requiredRange: range,
      subject: input.subject,
      ...(resolution ? { resolution } : {}),
    });
  }
  return conflicts;
};

const candidateConflicts = (input: PeerAnalysisInput): PeerConflict[] => {
  const conflicts: PeerConflict[] = [];
  for (const [peer, range] of Object.entries(
    input.candidate.peerDependencies
  )) {
    const optional = input.candidate.optionalPeers.includes(peer);
    const installed = input.versionOf(peer);
    if (installed === undefined) {
      if (!optional) {
        conflicts.push({
          blocker: peer,
          candidateVersion: input.candidate.version,
          confidence: "potential",
          direction: "candidate-requires-peer",
          evidence: "registry",
          note: `${input.subject}@${input.candidate.version} requires peer ${peer}@${range}, which is not installed.`,
          optional,
          requiredRange: range,
          subject: input.subject,
        });
      }
      continue;
    }
    const verdict = satisfiesPeer(installed, range);
    if (verdict === true) {
      continue;
    }
    conflicts.push({
      blocker: peer,
      blockerVersion: installed,
      candidateVersion: input.candidate.version,
      confidence: verdict === false && !optional ? "confirmed" : "potential",
      direction: "candidate-requires-peer",
      evidence: "installed",
      note:
        verdict === undefined
          ? `The peer range ${range} required by ${input.subject}@${input.candidate.version} cannot be evaluated.`
          : `${input.subject}@${input.candidate.version} requires peer ${peer}@${range}, but ${installed} is in use.`,
      optional,
      requiredRange: range,
      subject: input.subject,
    });
  }
  return conflicts;
};

/** Evaluates one candidate version against the peer requirements known for it. */
export function analyzePeerCompatibility(
  input: PeerAnalysisInput
): PeerAnalysis {
  const conflicts = [
    ...dependentConflicts(input),
    ...candidateConflicts(input),
  ];
  const confirmed = conflicts.filter(
    (conflict) => conflict.confidence === "confirmed"
  );
  let status: PeerAnalysis["status"] = "compatible";
  if (confirmed.length > 0) {
    status = "blocked";
  } else if (conflicts.length > 0) {
    status = "potential-conflict";
  } else if (input.incomplete) {
    status = "unknown";
  }
  const coordinated =
    confirmed.length > 0 &&
    confirmed.every((conflict) => conflict.resolution !== undefined)
      ? confirmed.flatMap((conflict) =>
          conflict.resolution ? [conflict.resolution] : []
        )
      : [];
  return { conflicts, coordinatedUpgrade: coordinated, status };
}
