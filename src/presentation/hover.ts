import {
  type DependencyAnalysis,
  currentAdvisories,
  currentSecurity,
  introducedAdvisories,
} from "../domain/dependency/analysis";
import { nodeCompatibility } from "../domain/version/node-compat";
import { compareSeverity } from "../domain/vulnerability/advisory";
import { formatCount, formatRelativeTime } from "../shared/utilities/time";
import { blockersOf } from "./annotation";
import { COMMANDS } from "./lenses";
import { clip, commandLink, escapeMarkdown, safeLink } from "./markdown";

export interface HoverContext {
  readonly now: number;
  readonly showLatestHint: boolean;
  readonly monthlyDownloads?: number;
  readonly prereleaseEnabled: boolean;
  /** The Node range the project declares, to flag updates that need a newer one. */
  readonly projectNodeEngine?: string;
}

const MAX_ADVISORIES = 5;
const MAX_REFERENCES = 3;

const row = (label: string, value: string | undefined): string | undefined =>
  value === undefined ? undefined : `**${label}:** ${value}`;

const code = (value: string): string => `\`${value.replaceAll("`", "'")}\``;

const versionLine = (analysis: DependencyAnalysis): string[] => {
  const { currentVersion } = analysis;
  const license =
    currentVersion === undefined
      ? undefined
      : analysis.releaseDetails[currentVersion]?.license;
  const lines: (string | undefined)[] = [
    row("Declared", code(analysis.declaration.specifier)),
    row(
      "Installed",
      analysis.installedVersion === undefined
        ? "not found in `node_modules`"
        : code(analysis.installedVersion)
    ),
    row(
      "Resolves to",
      analysis.resolvedVersion === undefined
        ? undefined
        : code(analysis.resolvedVersion)
    ),
    row("License", license === undefined ? undefined : code(license)),
  ];
  return lines.filter((line): line is string => line !== undefined);
};

/** Warnings about what the target release changes: its license and the Node it needs. */
const targetReleaseWarnings = (
  analysis: DependencyAnalysis,
  context: HoverContext
): string[] => {
  const target = analysis.selection?.target;
  if (!target) {
    return [];
  }
  const warnings: string[] = [];
  const { currentVersion } = analysis;
  const before =
    currentVersion === undefined
      ? undefined
      : analysis.releaseDetails[currentVersion]?.license;
  const details = analysis.releaseDetails[target.version];
  if (
    before !== undefined &&
    details?.license !== undefined &&
    details.license !== before
  ) {
    warnings.push(
      `⚠ **License changes in ${code(target.version)}:** ${code(before)} → ${code(details.license)}`
    );
  }
  if (
    context.projectNodeEngine !== undefined &&
    details?.nodeEngine !== undefined &&
    nodeCompatibility(context.projectNodeEngine, details.nodeEngine) ===
      "incompatible"
  ) {
    warnings.push(
      `⚠ ${code(target.version)} requires Node ${code(details.nodeEngine)}; this project declares ${code(context.projectNodeEngine)}.`
    );
  }
  return warnings;
};

const updateLines = (
  analysis: DependencyAnalysis,
  context: HoverContext
): string[] => {
  const { selection } = analysis;
  const lines: string[] = [];
  if (!selection) {
    return lines;
  }
  if (context.showLatestHint) {
    const latest = selection.latestPublished;
    const published =
      latest === undefined
        ? undefined
        : analysis.selection?.stableCandidates.find((c) => c.version === latest)
            ?.publishedAt;
    const age = formatRelativeTime(published, context.now);
    const latestText =
      latest === undefined
        ? undefined
        : `${code(latest)}${age ? ` (${age})` : ""}`;
    const compatible =
      analysis.compatibleCandidate?.version ?? selection.target?.version;
    const items = [
      row("Latest published", latestText),
      row(
        "Latest compatible",
        compatible === undefined ? undefined : code(compatible)
      ),
    ];
    lines.push(...items.filter((line): line is string => line !== undefined));
  }
  const available = (["major", "minor", "patch"] as const).flatMap((key) => {
    const candidate = selection[key];
    return candidate ? [`${key}: ${code(candidate.version)}`] : [];
  });
  if (available.length > 0) {
    lines.push(`**Available updates:** ${available.join(" · ")}`);
  }
  if (selection.heldBack.length > 0) {
    const count = selection.heldBack.length;
    lines.push(
      `_${count} newer ${count === 1 ? "version is" : "versions are"} held back by the minimum release age (${code("manifestLens.minimumReleaseAge")} or the package manager's own setting)._`
    );
  }
  const { target } = selection;
  const age = formatRelativeTime(target?.publishedAt, context.now);
  if (target && age) {
    lines.push(`**Target ${code(target.version)} published:** ${age}`);
  }
  if (target?.potentiallyBreaking) {
    lines.push(`_${code(target.version)} may contain breaking changes._`);
  }
  lines.push(...targetReleaseWarnings(analysis, context));
  return lines;
};

const peerSection = (analysis: DependencyAnalysis): string[] => {
  const target = analysis.selection?.target;
  const peer = target ? analysis.peer[target.version] : undefined;
  if (!(target && peer) || peer.conflicts.length === 0) {
    return peer?.status === "unknown"
      ? [
          "",
          "**Peer dependencies:** could not be verified (metadata unavailable).",
        ]
      : [];
  }
  const heading =
    peer.status === "blocked"
      ? `**Blocked by ${blockersOf(analysis, target.version).length} dependenc${blockersOf(analysis, target.version).length === 1 ? "y" : "ies"}**`
      : "**Possible peer conflicts**";
  const lines = ["", heading];
  for (const conflict of peer.conflicts) {
    let resolution = "";
    if (conflict.resolution) {
      resolution = ` — newer ${code(`${conflict.resolution.package}@${conflict.resolution.version}`)} relaxes this requirement`;
    } else if (conflict.direction === "blocker-restricts-candidate") {
      resolution = " — no newer release relaxes this requirement";
    }
    lines.push(`- ${escapeMarkdown(clip(conflict.note, 200))}${resolution}`);
  }
  if (peer.coordinatedUpgrade.length > 0) {
    lines.push(
      "",
      `**Coordinated upgrade:** ${peer.coordinatedUpgrade.map((r) => code(`${r.package}@${r.version}`)).join(", ")}`
    );
  }
  return lines;
};

const securitySection = (analysis: DependencyAnalysis): string[] => {
  const security = currentSecurity(analysis);
  const lines: string[] = [];
  if (security?.state === "unknown") {
    lines.push(
      "",
      `**Security:** advisory data unavailable (${escapeMarkdown(clip(security.reason, 120))}). This is not a clean result.`
    );
  }
  const advisories = currentAdvisories(analysis).toSorted((a, b) =>
    compareSeverity(a.advisory.severity, b.advisory.severity)
  );
  if (advisories.length > 0) {
    lines.push(
      "",
      `**${advisories.length} known ${advisories.length === 1 ? "advisory" : "advisories"} affect ${code(analysis.currentVersion ?? "")}**`
    );
    for (const match of advisories.slice(0, MAX_ADVISORIES)) {
      const { advisory } = match;
      const fix = match.fixedVersions[0]
        ? ` Fixed in ${code(match.fixedVersions[0])}.`
        : " No fixed version is known.";
      const link = advisory.references[0]
        ? safeLink(advisory.id, advisory.references[0].url)
        : escapeMarkdown(advisory.id);
      lines.push(
        `- ${link} (${advisory.severity}) — ${escapeMarkdown(clip(advisory.summary, 140))}.${fix}`
      );
      for (const reference of advisory.references.slice(1, MAX_REFERENCES)) {
        lines.push(`  - ${safeLink(reference.url, reference.url)}`);
      }
    }
    if (advisories.length > MAX_ADVISORIES) {
      lines.push(`- …and ${advisories.length - MAX_ADVISORIES} more`);
    }
  }
  const target = analysis.selection?.target;
  if (target) {
    const introduced = introducedAdvisories(analysis, target.version);
    if (introduced.length > 0) {
      lines.push(
        "",
        `**Warning:** ${code(target.version)} is affected by ${introduced.length} advisor${introduced.length === 1 ? "y" : "ies"} that the current version is not: ${introduced.map((m) => escapeMarkdown(m.advisory.id)).join(", ")}.`
      );
    }
  }
  return lines;
};

const actionLinks = (analysis: DependencyAnalysis): string[] => {
  const target = analysis.selection?.target;
  const links: string[] = [];
  if (target && analysis.peer[target.version]?.status !== "blocked") {
    links.push(
      commandLink(`Update to ${target.version}`, COMMANDS.updateDependency, [
        analysis.key,
        target.version,
      ]),
      commandLink("Install Update", COMMANDS.updateDependencyAndInstall, [
        analysis.key,
        target.version,
      ])
    );
  }
  links.push(
    safeLink("npm", analysis.links.npm),
    safeLink("Versions", analysis.links.versions)
  );
  if (analysis.links.releases) {
    links.push(safeLink("Releases", analysis.links.releases));
  }
  if (analysis.links.homepage) {
    links.push(safeLink("Homepage", analysis.links.homepage));
  }
  if (analysis.links.repository) {
    links.push(safeLink("Repository", analysis.links.repository));
  }
  return links;
};

/** Markdown for the hover over a dependency. Remote text is escaped and clipped. */
export function hoverMarkdown(
  analysis: DependencyAnalysis,
  context: HoverContext
): string {
  const lines: string[] = [`### ${escapeMarkdown(analysis.registryName)}`];
  if (analysis.description) {
    lines.push(escapeMarkdown(clip(analysis.description, 240)));
  }
  if (analysis.support.kind === "unsupported") {
    lines.push("", `_${escapeMarkdown(analysis.support.detail)}_`);
    return lines.join("\n");
  }
  if (analysis.registry.kind === "error") {
    lines.push(
      "",
      `**Registry unavailable:** ${escapeMarkdown(clip(analysis.registry.error.message, 160))}. This dependency is **not** reported as up to date.`
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    ...versionLine(analysis).map((line) => `${line}  `),
    ...updateLines(analysis, context).map((line) => `${line}  `)
  );
  if (context.monthlyDownloads !== undefined) {
    lines.push(
      `**Downloads:** ${formatCount(context.monthlyDownloads)} / month  `
    );
  }
  if (analysis.deprecation) {
    lines.push(
      "",
      `**Deprecated (${code(analysis.deprecation.version)}):** ${escapeMarkdown(clip(analysis.deprecation.message, 200))}`
    );
  }
  lines.push(
    ...securitySection(analysis),
    ...peerSection(analysis),
    "",
    actionLinks(analysis).join(" · ")
  );
  return lines.join("\n");
}
