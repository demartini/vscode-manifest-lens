import semver from "semver";

import {
  type CatalogSource,
  type DependencyAnalysis,
  type ManifestAnalysis,
  type RegistryState,
  type SupportState,
  type VersionSecurity,
  deriveStatus,
  summarize,
} from "../../domain/dependency/analysis";
import type {
  InstalledPackage,
  PackageMetadata,
  ReleaseDetails,
} from "../../domain/dependency/metadata";
import type {
  DependencyDeclaration,
  ParsedManifest,
} from "../../domain/manifest/types";
import {
  type ManagerReleaseAge,
  isExcludedFromReleaseAge,
} from "../../domain/package-manager/release-age";
import { analyzePeerCompatibility } from "../../domain/peer-conflict/analysis";
import type {
  PeerAnalysis,
  PeerPackageInfo,
  PeerRelease,
} from "../../domain/peer-conflict/types";
import {
  type Candidate,
  type PrereleasePolicy,
  type ReleaseInfo,
  type VersionSelection,
  selectVersions,
} from "../../domain/version/candidates";
import {
  type ParsedSpecifier,
  parseSpecifier,
  registryName,
  rewriteSpecifier,
} from "../../domain/version/specifier";
import { matchAdvisories } from "../../domain/vulnerability/matching";
import { ManifestLensError } from "../../shared/errors";
import { type Logger, silentLogger } from "../../shared/logger";
import { mapLimit, throwIfAborted } from "../../shared/utilities/concurrency";
import {
  type AdvisoryPort,
  type Clock,
  type InstalledPackagesPort,
  type RegistryPort,
  advisoryKey,
} from "../ports";

export interface AnalysisSettings {
  /** Minutes a version must have been published before it is suggested; 0 disables it. */
  readonly minimumReleaseAge: number;
  readonly prerelease: PrereleasePolicy;
  readonly securityEnabled: boolean;
  readonly peerEnabled: boolean;
  readonly concurrency: number;
}

export interface CatalogEntry {
  readonly specifier: string;
  readonly source: CatalogSource;
}

export interface AnalyzeRequest {
  readonly manifestUri: string;
  /** Filesystem directory of the manifest, used to locate `node_modules`. */
  readonly manifestDir: string | undefined;
  readonly documentVersion: number;
  readonly parsed: ParsedManifest;
  readonly settings: AnalysisSettings;
  /** Names of packages that live in this workspace. */
  readonly localPackageNames: ReadonlySet<string>;
  readonly resolveCatalog: (
    catalog: string,
    packageName: string
  ) => CatalogEntry | undefined;
  /** Dependency names declared by sibling manifests of the same workspace. */
  readonly workspaceDependencyNames: readonly string[];
  /** The package manager's own minimum release age, when the project configures one. */
  readonly managerReleaseAge?: ManagerReleaseAge;
  readonly signal?: AbortSignal;
}

export interface AnalyzerDependencies {
  readonly registry: RegistryPort;
  readonly advisories: AdvisoryPort;
  readonly installed: InstalledPackagesPort;
  readonly clock: Clock;
  readonly logger?: Logger;
}

interface Prepared {
  readonly declaration: DependencyDeclaration;
  readonly specifier: ParsedSpecifier;
  readonly support: SupportState;
  readonly rewritable: boolean;
  readonly catalogSource?: CatalogSource;
  readonly registryName: string;
}

type MetadataResult = Awaited<ReturnType<RegistryPort["getPackage"]>>;

const PEER_CANDIDATE_LIMIT = 4;
const PROBE_VERSION = "999.0.0";
const DEPENDENT_SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]);

const unsupported = (
  reason: Extract<SupportState, { kind: "unsupported" }>["reason"],
  detail: string
): SupportState => ({
  detail,
  kind: "unsupported",
  reason,
});

const classify = (
  declaration: DependencyDeclaration,
  request: AnalyzeRequest
): Pick<Prepared, "catalogSource" | "specifier" | "support"> => {
  let specifier = parseSpecifier(declaration.specifier);
  let catalogSource: CatalogSource | undefined;
  if (specifier.kind === "catalog") {
    const entry = request.resolveCatalog(specifier.catalog, declaration.name);
    if (!entry) {
      return {
        specifier,
        support: unsupported(
          "catalog-unresolved",
          `No catalog entry for ${declaration.name} was found (${declaration.specifier}).`
        ),
      };
    }
    catalogSource = entry.source;
    specifier = parseSpecifier(entry.specifier);
  }
  const withSource = catalogSource ? { catalogSource } : {};
  const effective = specifier.kind === "alias" ? specifier.inner : specifier;
  const supported: SupportState = { kind: "supported" };
  switch (effective.kind) {
    case "range":
    case "partial":
    case "complex": {
      if (
        request.localPackageNames.has(declaration.name) &&
        specifier.kind !== "alias"
      ) {
        return {
          ...withSource,
          specifier,
          support: unsupported(
            "workspace",
            "Resolved from a package in this workspace."
          ),
        };
      }
      return { ...withSource, specifier, support: supported };
    }
    case "workspace": {
      return {
        ...withSource,
        specifier,
        support: unsupported("workspace", "Workspace protocol reference."),
      };
    }
    case "local": {
      return {
        ...withSource,
        specifier,
        support: unsupported("local", "Local path dependency."),
      };
    }
    case "remote": {
      return {
        ...withSource,
        specifier,
        support: unsupported("remote", "Git or URL dependency."),
      };
    }
    case "tag": {
      return {
        ...withSource,
        specifier,
        support: unsupported(
          "tag",
          `Tracks the "${effective.tag}" tag, which is not version-pinned.`
        ),
      };
    }
    default: {
      return {
        ...withSource,
        specifier,
        support: unsupported(
          "invalid",
          `"${declaration.specifier}" is not a recognized version specifier.`
        ),
      };
    }
  }
};

const prepare = (
  declaration: DependencyDeclaration,
  request: AnalyzeRequest
): Prepared => {
  const { specifier, support, catalogSource } = classify(declaration, request);
  return {
    ...(catalogSource ? { catalogSource } : {}),
    declaration,
    registryName: registryName(declaration.name, specifier),
    rewritable:
      support.kind === "supported" &&
      rewriteSpecifier(specifier, PROBE_VERSION) !== undefined,
    specifier,
    support,
  };
};

const toReleases = (metadata: PackageMetadata): ReleaseInfo[] =>
  Object.values(metadata.versions).map((version) => ({
    ...(version.deprecated === undefined
      ? {}
      : { deprecated: version.deprecated }),
    ...(version.publishedAt === undefined
      ? {}
      : { publishedAt: version.publishedAt }),
    version: version.version,
  }));

const npmUrl = (name: string): string =>
  `https://www.npmjs.com/package/${name}`;

type Selection = ReturnType<typeof selectVersions>;
type InstalledMap = ReadonlyMap<string, InstalledPackage>;
type MetadataMap = ReadonlyMap<string, MetadataResult>;
type PeerMap = ReadonlyMap<string, Record<string, PeerAnalysis>>;

interface PeerContext {
  readonly prepared: readonly Prepared[];
  readonly metadata: MetadataMap;
  readonly installed: InstalledMap;
  readonly selections: ReadonlyMap<string, Selection>;
  readonly request: AnalyzeRequest;
}

const candidatesOf = (selection: Selection | undefined): Candidate[] => {
  if (!selection) {
    return [];
  }
  const seen = new Map<string, Candidate>();
  for (const candidate of [
    selection.target,
    selection.major,
    selection.minor,
    selection.patch,
  ]) {
    if (candidate) {
      seen.set(candidate.version, candidate);
    }
  }
  return [...seen.values()].slice(0, PEER_CANDIDATE_LIMIT);
};

const toDependent = (name: string, pkg: InstalledPackage): PeerPackageInfo => ({
  name,
  optionalPeers: pkg.optionalPeers,
  peerDependencies: pkg.peerDependencies,
  source: "installed",
  version: pkg.version,
});

/** Collects the packages whose peer ranges may constrain other dependencies. */
const buildDependents = (
  context: PeerContext,
  extraInstalled: InstalledMap
): { dependents: PeerPackageInfo[]; incomplete: boolean } => {
  const dependents: PeerPackageInfo[] = [];
  let incomplete = false;
  const direct = context.prepared.filter((item) =>
    DEPENDENT_SECTIONS.has(item.declaration.section)
  );
  for (const item of direct) {
    const pkg = context.installed.get(item.declaration.id);
    const meta = context.metadata.get(item.registryName);
    const latest = context.selections.get(
      item.declaration.id
    )?.latestSatisfying;
    const declared =
      meta?.ok === true && latest !== undefined
        ? meta.value.versions[latest]
        : undefined;
    if (pkg) {
      dependents.push(toDependent(item.registryName, pkg));
    } else if (declared) {
      dependents.push({
        name: item.registryName,
        optionalPeers: declared.optionalPeers,
        peerDependencies: declared.peerDependencies,
        source: "declared",
        version: declared.version,
      });
    } else if (item.support.kind === "supported") {
      incomplete = true;
    }
  }
  for (const [name, pkg] of extraInstalled) {
    dependents.push(toDependent(name, pkg));
  }
  return { dependents, incomplete };
};

const stableReleases = (metadata: PackageMetadata): PeerRelease[] =>
  Object.values(metadata.versions)
    .filter(
      (version) =>
        semver.valid(version.version) !== null &&
        semver.prerelease(version.version) === null
    )
    .toSorted((a, b) => semver.rcompare(a.version, b.version))
    .map((version) => ({
      peerDependencies: version.peerDependencies,
      version: version.version,
    }));

const peerNamesOf = (item: Prepared, context: PeerContext): string[] => {
  const meta = context.metadata.get(item.registryName);
  if (meta?.ok !== true) {
    return [];
  }
  return candidatesOf(context.selections.get(item.declaration.id)).flatMap(
    (candidate) =>
      Object.keys(
        meta.value.versions[candidate.version]?.peerDependencies ?? {}
      )
  );
};

const compatibleFallback = (
  selection: Selection | undefined,
  peer: Record<string, PeerAnalysis>
): Candidate | undefined => {
  const target = selection?.target;
  if (!(selection && target) || peer[target.version]?.status !== "blocked") {
    return undefined;
  }
  return [selection.major, selection.minor, selection.patch]
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .toSorted((a, b) => semver.rcompare(a.version, b.version))
    .find(
      (candidate) =>
        peer[candidate.version]?.status !== "blocked" &&
        candidate.version !== target.version
    );
};

const registryStateOf = (
  item: Prepared,
  result: MetadataResult | undefined
): RegistryState => {
  if (item.support.kind !== "supported") {
    return { kind: "skipped" };
  }
  if (result?.ok === true) {
    return { fetchedAt: result.value.fetchedAt, kind: "ok" };
  }
  return {
    error:
      result?.ok === false
        ? result.error
        : new ManifestLensError("unexpected", "No registry data."),
    kind: "error",
  };
};

const securityFor = (
  packageName: string,
  security: ReadonlyMap<string, VersionSecurity> | undefined
): Record<string, VersionSecurity> => {
  const byVersion: Record<string, VersionSecurity> = {};
  const prefix = `${packageName}@`;
  for (const [key, value] of security ?? []) {
    if (key.startsWith(prefix)) {
      byVersion[key.slice(prefix.length)] = value;
    }
  }
  return byVersion;
};

/** Runs the full dependency analysis for one manifest. */
/**
 * How long a version must have been published: the stricter of the user's setting and
 * the package manager's own, which does not apply to packages it excludes.
 */
const releaseAgeLimit =
  (
    name: string,
    ownMinutes: number,
    manager: ManagerReleaseAge | undefined
  ): ((version: string) => number) =>
  (version) =>
    Math.max(
      ownMinutes,
      manager === undefined ||
        isExcludedFromReleaseAge(manager.exclude, name, version)
        ? 0
        : manager.minimumMinutes
    ) * 60_000;

/** License and Node engine for the current version and every candidate the hover can mention. */
const releaseDetailsOf = (
  meta: PackageMetadata | undefined,
  currentVersion: string | undefined,
  selection: VersionSelection | undefined
): Record<string, ReleaseDetails> => {
  const versions = new Set<string>();
  if (currentVersion !== undefined) {
    versions.add(currentVersion);
  }
  for (const candidate of selection?.stableCandidates ?? []) {
    versions.add(candidate.version);
  }
  if (selection?.prerelease) {
    versions.add(selection.prerelease.version);
  }
  const details: Record<string, ReleaseDetails> = {};
  for (const version of versions) {
    const release = meta?.versions[version];
    if (release?.license !== undefined || release?.nodeEngine !== undefined) {
      details[version] = {
        ...(release.license === undefined ? {} : { license: release.license }),
        ...(release.nodeEngine === undefined
          ? {}
          : { nodeEngine: release.nodeEngine }),
      };
    }
  }
  return details;
};

export class ManifestAnalyzer {
  private readonly deps: AnalyzerDependencies;
  private readonly logger: Logger;

  constructor(deps: AnalyzerDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? silentLogger;
  }

  async analyze(request: AnalyzeRequest): Promise<ManifestAnalysis> {
    const { signal } = request;
    const prepared = request.parsed.declarations.map((declaration) =>
      prepare(declaration, request)
    );
    const supported = prepared.filter(
      (item) => item.support.kind === "supported"
    );
    const metadata = await this.fetchMetadata(supported, request);
    throwIfAborted(signal);
    const installed = await this.findInstalled(supported, request);
    throwIfAborted(signal);

    const selections = new Map<string, Selection>();
    for (const item of supported) {
      const result = metadata.get(item.registryName);
      if (result?.ok === true) {
        const version = installed.get(item.declaration.id)?.version;
        selections.set(
          item.declaration.id,
          selectVersions({
            distTags: result.value.distTags,
            prerelease: request.settings.prerelease,
            releaseAge: {
              limitMs: releaseAgeLimit(
                item.registryName,
                request.settings.minimumReleaseAge,
                request.managerReleaseAge
              ),
              now: this.deps.clock.now(),
            },
            releases: toReleases(result.value),
            specifier: item.specifier,
            ...(version === undefined ? {} : { installedVersion: version }),
          })
        );
      }
    }

    const context: PeerContext = {
      installed,
      metadata,
      prepared,
      request,
      selections,
    };
    const peers: PeerMap = request.settings.peerEnabled
      ? await this.analyzePeers(context)
      : new Map();
    throwIfAborted(signal);

    const security = request.settings.securityEnabled
      ? await this.checkSecurity(context, supported, peers)
      : undefined;
    throwIfAborted(signal);

    const items = prepared.map((item) =>
      this.assemble(item, context, peers, security)
    );
    const issues = [...request.parsed.issues];
    const partial =
      items.some((item) => item.status === "error") ||
      items.some((item) =>
        Object.values(item.security).some((entry) => entry.state === "unknown")
      );
    if (partial) {
      issues.push(
        "Some data could not be retrieved; results may be incomplete."
      );
    }
    return {
      analyzedAt: this.deps.clock.now(),
      documentVersion: request.documentVersion,
      issues,
      items,
      manifestUri: request.manifestUri,
      partial,
      summary: summarize(items),
    };
  }

  private async fetchMetadata(
    supported: readonly Prepared[],
    request: AnalyzeRequest
  ): Promise<Map<string, MetadataResult>> {
    const names = [...new Set(supported.map((item) => item.registryName))];
    const results = await mapLimit(
      names,
      request.settings.concurrency,
      async (name) => await this.deps.registry.getPackage(name, request.signal),
      request.signal
    );
    const byName = new Map<string, MetadataResult>();
    for (const [index, name] of names.entries()) {
      const result = results[index];
      if (result) {
        byName.set(name, result);
      }
    }
    return byName;
  }

  private async lookupMany<K>(
    keys: readonly K[],
    request: AnalyzeRequest,
    nameOf: (key: K) => string
  ): Promise<Map<K, InstalledPackage>> {
    const found = new Map<K, InstalledPackage>();
    const { manifestDir } = request;
    if (manifestDir === undefined) {
      return found;
    }
    await mapLimit(
      keys,
      request.settings.concurrency,
      async (key) => {
        const pkg = await this.deps.installed.lookup(manifestDir, nameOf(key));
        if (pkg) {
          found.set(key, pkg);
        }
      },
      request.signal
    );
    return found;
  }

  private async findInstalled(
    supported: readonly Prepared[],
    request: AnalyzeRequest
  ): Promise<Map<string, InstalledPackage>> {
    const byId = new Map(supported.map((item) => [item.declaration.id, item]));
    return await this.lookupMany(
      [...byId.keys()],
      request,
      (id) => byId.get(id)?.declaration.name ?? id
    );
  }

  private async fetchReleases(
    names: readonly string[],
    context: PeerContext
  ): Promise<{ releases: Map<string, PeerRelease[]>; failed: boolean }> {
    const releases = new Map<string, PeerRelease[]>();
    let failed = false;
    await mapLimit(
      names,
      context.request.settings.concurrency,
      async (name) => {
        const result =
          context.metadata.get(name) ??
          (await this.deps.registry.getPackage(name, context.request.signal));
        if (result.ok) {
          releases.set(name, stableReleases(result.value));
        } else {
          failed = true;
        }
      },
      context.request.signal
    );
    return { failed, releases };
  }

  private async analyzePeers(context: PeerContext): Promise<PeerMap> {
    const { prepared, metadata, installed, selections, request } = context;
    const declaredNames = new Set(
      prepared.map((item) => item.declaration.name)
    );
    const extraNames = request.workspaceDependencyNames.filter(
      (name) => !declaredNames.has(name)
    );
    const extraInstalled = await this.lookupMany(
      extraNames,
      request,
      (name) => name
    );
    const { dependents, incomplete: missingData } = buildDependents(
      context,
      extraInstalled
    );

    const subjects = prepared.filter((item) =>
      selections.has(item.declaration.id)
    );
    const restricting = new Set<string>();
    for (const item of subjects) {
      for (const dependent of dependents) {
        if (
          dependent.name !== item.registryName &&
          dependent.peerDependencies[item.registryName] !== undefined
        ) {
          restricting.add(dependent.name);
        }
      }
    }
    const { releases, failed } = await this.fetchReleases(
      [...restricting],
      context
    );
    const peerNames = [
      ...new Set(subjects.flatMap((item) => peerNamesOf(item, context))),
    ];
    const installedPeers = await this.lookupMany(
      peerNames,
      request,
      (name) => name
    );

    const versionByName = new Map<string, string>();
    for (const item of prepared) {
      const pkg = installed.get(item.declaration.id);
      if (pkg) {
        versionByName.set(item.registryName, pkg.version);
      }
    }
    for (const [name, pkg] of installedPeers) {
      if (!versionByName.has(name)) {
        versionByName.set(name, pkg.version);
      }
    }

    const result = new Map<string, Record<string, PeerAnalysis>>();
    for (const item of subjects) {
      const meta = metadata.get(item.registryName);
      if (meta?.ok !== true) {
        continue;
      }
      const analyses: Record<string, PeerAnalysis> = {};
      for (const candidate of candidatesOf(
        selections.get(item.declaration.id)
      )) {
        const version = meta.value.versions[candidate.version];
        if (version) {
          analyses[candidate.version] = analyzePeerCompatibility({
            candidate: {
              optionalPeers: version.optionalPeers,
              peerDependencies: version.peerDependencies,
              version: version.version,
            },
            dependents: dependents.filter(
              (dependent) => dependent.name !== item.registryName
            ),
            incomplete: missingData || failed,
            newerReleasesOf: (name) => releases.get(name) ?? [],
            subject: item.registryName,
            versionOf: (name) => versionByName.get(name),
          });
        }
      }
      result.set(item.declaration.id, analyses);
    }
    return result;
  }

  private async checkSecurity(
    context: PeerContext,
    supported: readonly Prepared[],
    peers: PeerMap
  ): Promise<Map<string, VersionSecurity>> {
    const queries = new Map<string, { name: string; version: string }>();
    for (const item of supported) {
      const { id } = item.declaration;
      const selection = context.selections.get(id);
      if (!selection) {
        continue;
      }
      const versions = new Set<string>(Object.keys(peers.get(id) ?? {}));
      const current =
        context.installed.get(id)?.version ?? selection.baseVersion;
      if (current !== undefined) {
        versions.add(current);
      }
      for (const candidate of candidatesOf(selection)) {
        versions.add(candidate.version);
      }
      for (const version of versions) {
        const query = { name: item.registryName, version };
        queries.set(advisoryKey(query), query);
      }
    }
    const raw = await this.deps.advisories.query(
      [...queries.values()],
      context.request.signal
    );
    const out = new Map<string, VersionSecurity>();
    for (const [key, query] of queries) {
      const result = raw.get(key);
      if (!result) {
        out.set(key, { reason: "No result was returned.", state: "unknown" });
      } else if (result.ok) {
        out.set(key, {
          advisories: matchAdvisories(result.value, query.name, query.version)
            .matched,
          state: "checked",
        });
      } else {
        this.logger.warn(
          `Advisory lookup failed for ${key}: ${result.error.message}`
        );
        out.set(key, { reason: result.error.message, state: "unknown" });
      }
    }
    return out;
  }

  private assemble(
    item: Prepared,
    context: PeerContext,
    peers: PeerMap,
    security: ReadonlyMap<string, VersionSecurity> | undefined
  ): DependencyAnalysis {
    const { id } = item.declaration;
    const result = context.metadata.get(item.registryName);
    const selection = context.selections.get(id);
    const pkg = context.installed.get(id);
    const peer = peers.get(id) ?? {};
    const registry = registryStateOf(item, result);
    const meta = result?.ok === true ? result.value : undefined;
    const currentVersion = pkg?.version ?? selection?.baseVersion;
    const deprecated =
      currentVersion === undefined
        ? undefined
        : (pkg?.deprecated ?? meta?.versions[currentVersion]?.deprecated);
    const compatibleCandidate = compatibleFallback(selection, peer);
    return {
      ...(item.catalogSource ? { catalogSource: item.catalogSource } : {}),
      ...(compatibleCandidate ? { compatibleCandidate } : {}),
      ...(currentVersion === undefined
        ? {}
        : {
            currentVersion,
            currentVersionBasis: pkg ? "installed" : "declared-minimum",
          }),
      ...(currentVersion !== undefined && deprecated !== undefined
        ? { deprecation: { message: deprecated, version: currentVersion } }
        : {}),
      ...(meta?.description === undefined
        ? {}
        : { description: meta.description }),
      declaration: item.declaration,
      ...(pkg ? { installedVersion: pkg.version } : {}),
      key: `${context.request.manifestUri}#${id}`,
      ...(selection?.latestPublished === undefined
        ? {}
        : { latestVersion: selection.latestPublished }),
      links: {
        ...(meta?.homepage === undefined ? {} : { homepage: meta.homepage }),
        npm: npmUrl(item.registryName),
        ...(meta?.repositoryUrl === undefined
          ? {}
          : { repository: meta.repositoryUrl }),
      },
      manifestUri: context.request.manifestUri,
      peer,
      registry,
      registryName: item.registryName,
      releaseDetails: releaseDetailsOf(meta, currentVersion, selection),
      ...(selection?.latestSatisfying === undefined
        ? {}
        : { resolvedVersion: selection.latestSatisfying }),
      rewritable: item.rewritable,
      ...(selection ? { selection } : {}),
      security: securityFor(item.registryName, security),
      specifier: item.specifier,
      status: deriveStatus({
        peer,
        registry,
        selection,
        support: item.support,
      }),
      support: item.support,
    };
  }
}
