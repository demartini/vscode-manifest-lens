import * as assert from "node:assert/strict";

import { ManifestAnalyzer } from "../../../src/application/analyze-manifest/analyze-manifest";
import type { DependencyAnalysis } from "../../../src/domain/dependency/analysis";
import { parsePackageJson } from "../../../src/domain/manifest/package-json";
import { annotationOf } from "../../../src/presentation/annotation";
import { codeActionsFor } from "../../../src/presentation/code-actions";
import { NO_FILTERS, matchesFilters } from "../../../src/presentation/filters";
import { hoverMarkdown } from "../../../src/presentation/hover";
import { lensesFor, sectionLens } from "../../../src/presentation/lenses";
import {
  clip,
  escapeMarkdown,
  safeLink,
} from "../../../src/presentation/markdown";
import { statusFor } from "../../../src/presentation/status";
import { formatRelativeTime } from "../../../src/shared/utilities/time";
import {
  FakeAdvisories,
  FakeInstalled,
  FakeRegistry,
  NOW,
  makeAdvisory,
  pkg,
} from "../helpers";

const analyzeAll = async () => {
  const registry = new FakeRegistry()
    .add(pkg("current", { "1.0.0": {} }))
    .add(pkg("patchy", { "1.0.0": {}, "1.0.1": {} }))
    .add(pkg("major", { "1.0.0": {}, "2.0.0": {} }))
    .add(pkg("vite", { "6.0.0": {}, "7.0.0": {} }))
    .add(pkg("plugin", { "1.0.0": { peers: { vite: "^6.0.0" } } }))
    .add(pkg("vuln", { "1.0.0": { deprecated: "Use vuln2" }, "1.1.0": {} }))
    .add(pkg("tagless", { "1.0.0": {}, "2.0.0-beta.1": {} }))
    .add(pkg("drift", { "1.0.0": {}, "1.2.0": {} }))
    .fail("offline");
  const installed = new FakeInstalled()
    .add("current", "1.0.0")
    .add("patchy", "1.0.0")
    .add("major", "1.0.0")
    .add("vite", "6.0.0")
    .add("plugin", "1.0.0", { vite: "^6.0.0" })
    .add("vuln", "1.0.0")
    .add("drift", "1.2.0");
  const advisories = new FakeAdvisories().add(
    "vuln",
    "1.0.0",
    makeAdvisory("GHSA-1", "vuln", [{ introduced: "0" }, { fixed: "1.1.0" }])
  );
  const analyzer = new ManifestAnalyzer({
    advisories,
    clock: { now: () => NOW },
    installed,
    registry,
  });
  const manifest = {
    dependencies: {
      current: "^1.0.0",
      drift: "^1.0.0",
      major: "^1.0.0",
      offline: "^1.0.0",
      patchy: "~1.0.0",
      plugin: "^1.0.0",
      tagless: "^1.0.0",
      vite: "^6.0.0",
      vuln: "^1.0.0",
      ws: "workspace:*",
    },
  };
  const analysis = await analyzer.analyze({
    documentVersion: 1,
    localPackageNames: new Set(),
    manifestDir: "/ws",
    manifestUri: "file:///ws/package.json",
    parsed: parsePackageJson(JSON.stringify(manifest, null, 2)),
    resolveCatalog: () => {},
    settings: {
      concurrency: 2,
      minimumReleaseAge: 0,
      peerEnabled: true,
      prerelease: { enabled: true, tags: [] },
      securityEnabled: true,
    },
    workspaceDependencyNames: [],
  });
  const get = (name: string): DependencyAnalysis => {
    const item = analysis.items.find(
      (candidate) => candidate.declaration.name === name
    );
    assert.ok(item);
    return item;
  };
  return { analysis, get };
};

const context = {
  minimumSeverity: "patch" as const,
  now: NOW,
  prereleaseEnabled: false,
  securityEnabled: true,
};

describe("annotationOf", () => {
  it("renders every documented state", async () => {
    const { get } = await analyzeAll();
    assert.equal(annotationOf(get("current"), context).text, "✓ up to date");
    assert.match(
      annotationOf(get("patchy"), context).text,
      /^⬆ 1\.0\.1 \(patch\) — 4 days ago/u
    );
    assert.match(
      annotationOf(get("major"), context).text,
      /^⬆ 2\.0\.0 \(major\)/u
    );
    assert.equal(annotationOf(get("major"), context).tone, "warning");
    assert.equal(
      annotationOf(get("vite"), context).text,
      "✋ 7.0.0 blocked by plugin"
    );
    const vuln = annotationOf(get("vuln"), context);
    assert.match(
      vuln.text,
      /^⚠ 1 advisory · ⊘ deprecated · ⬆ 1\.1\.0 \(minor\)/u
    );
    assert.equal(vuln.tone, "error");
    assert.equal(annotationOf(get("ws"), context).text, "◦ workspace");
  });

  it("never renders registry failures as up to date", async () => {
    const { get } = await analyzeAll();
    const { text } = annotationOf(get("offline"), context);
    assert.match(text, /registry unavailable/u);
    assert.doesNotMatch(text, /up to date/u);
  });

  it("filters update annotations by minimum severity but keeps warnings", async () => {
    const { get } = await analyzeAll();
    const major = { ...context, minimumSeverity: "major" as const };
    assert.equal(annotationOf(get("patchy"), major).text, "");
    assert.match(annotationOf(get("major"), major).text, /2\.0\.0/u);
    assert.match(annotationOf(get("vuln"), major).text, /advisory/u);
    assert.match(annotationOf(get("vite"), major).text, /blocked/u);
  });

  it("shows prerelease hints only when enabled", async () => {
    const { get } = await analyzeAll();
    assert.doesNotMatch(annotationOf(get("tagless"), context).text, /β/u);
    assert.match(
      annotationOf(get("tagless"), { ...context, prereleaseEnabled: true })
        .text,
      /β 2\.0\.0-beta\.1/u
    );
  });
});

describe("lensesFor / sectionLens", () => {
  it("offers resolve, update and install lenses", async () => {
    const { get } = await analyzeAll();
    const titles = lensesFor(get("patchy"), {
      prereleaseEnabled: false,
      showUpToDate: false,
    }).map((l) => l.title);
    assert.deepEqual(titles, ["Update to 1.0.1", "Install Update"]);
    const drift = lensesFor(get("drift"), {
      prereleaseEnabled: false,
      showUpToDate: false,
    });
    assert.deepEqual(
      drift.map((l) => l.title),
      ["Resolved as 1.2.0"]
    );
  });

  it("replaces update lenses with blocked lenses when peers conflict", async () => {
    const { get } = await analyzeAll();
    const lenses = lensesFor(get("vite"), {
      prereleaseEnabled: false,
      showUpToDate: false,
    });
    assert.deepEqual(
      lenses.map((l) => l.title),
      ["7.0.0 blocked by 1 dependency", "Install Blocked Update"]
    );
  });

  it("hides up-to-date dependencies unless asked, and offers retry on errors", async () => {
    const { get } = await analyzeAll();
    const none = lensesFor(get("current"), {
      prereleaseEnabled: false,
      showUpToDate: false,
    });
    assert.ok(none.every((lens) => lens.kind === "resolved"));
    const shown = lensesFor(get("tagless"), {
      prereleaseEnabled: true,
      showUpToDate: true,
    });
    assert.ok(shown.some((lens) => lens.kind === "prerelease"));
    assert.equal(
      lensesFor(get("offline"), {
        prereleaseEnabled: false,
        showUpToDate: false,
      })[0]?.kind,
      "retry"
    );
    assert.deepEqual(
      lensesFor(get("ws"), { prereleaseEnabled: false, showUpToDate: true }),
      []
    );
  });

  it("summarizes eligible and blocked updates per section", async () => {
    const { analysis } = await analyzeAll();
    const parsed = parsePackageJson(
      JSON.stringify(
        {
          dependencies: Object.fromEntries(
            analysis.items.map((i) => [
              i.declaration.name,
              i.declaration.specifier,
            ])
          ),
        },
        null,
        2
      )
    );
    const [section] = parsed.sections;
    assert.ok(section);
    const lens = sectionLens(analysis.manifestUri, section, analysis.items, {
      prereleaseEnabled: false,
      showUpToDate: false,
    });
    assert.match(
      lens?.title ?? "",
      /updates? available · 1 blocked — Update all/u
    );
  });
});

describe("hoverMarkdown", () => {
  it("includes versions, advisories, peer blockers and links, escaping remote text", async () => {
    const { get } = await analyzeAll();
    const vuln = hoverMarkdown(get("vuln"), {
      now: NOW,
      prereleaseEnabled: false,
      showLatestHint: true,
    });
    assert.match(vuln, /GHSA\\-1/u);
    assert.match(vuln, /Fixed in `1\.1\.0`/u);
    assert.match(vuln, /Deprecated/u);
    const vite = hoverMarkdown(get("vite"), {
      monthlyDownloads: 1_200_000,
      now: NOW,
      prereleaseEnabled: false,
      showLatestHint: true,
    });
    assert.match(vite, /Blocked by 1 dependency/u);
    assert.match(vite, /Downloads:\*\* 1\.2M/u);
    assert.match(vite, /npmjs\.com\/package\/vite/u);
  });

  it("says when newer versions are held back by the minimum release age", async () => {
    const { get } = await analyzeAll();
    const patchy = get("patchy");
    const [candidate] = patchy.selection?.stableCandidates ?? [];
    assert.ok(candidate && patchy.selection);
    const held = hoverMarkdown(
      {
        ...patchy,
        selection: {
          ...patchy.selection,
          heldBack: [candidate],
          target: undefined,
        },
      },
      { now: NOW, prereleaseEnabled: false, showLatestHint: true }
    );
    assert.match(held, /1 newer version is held back/u);
    assert.match(held, /minimum release age/u);
    const none = hoverMarkdown(patchy, {
      now: NOW,
      prereleaseEnabled: false,
      showLatestHint: true,
    });
    assert.doesNotMatch(none, /held back/u);
  });

  describe("release details", () => {
    const hoverContext = {
      now: NOW,
      prereleaseEnabled: false,
      projectNodeEngine: ">=18",
      showLatestHint: true,
    };
    const withDetails = async (
      releaseDetails: DependencyAnalysis["releaseDetails"]
    ) => ({ ...(await analyzeAll()).get("patchy"), releaseDetails });

    it("shows the license of the current version", async () => {
      const text = hoverMarkdown(
        await withDetails({ "1.0.0": { license: "MIT" } }),
        hoverContext
      );
      assert.match(text, /License:\*\* `MIT`/u);
      assert.doesNotMatch(text, /License changes/u);
    });

    it("warns when the update changes the license", async () => {
      const text = hoverMarkdown(
        await withDetails({
          "1.0.0": { license: "MIT" },
          "1.0.1": { license: "BUSL-1.1" },
        }),
        hoverContext
      );
      assert.match(
        text,
        /License changes in `1\.0\.1`:\*\* `MIT` → `BUSL-1\.1`/u
      );
    });

    it("warns when the update needs a newer Node than the project declares", async () => {
      const text = hoverMarkdown(
        await withDetails({ "1.0.1": { nodeEngine: ">=22" } }),
        hoverContext
      );
      assert.match(text, /`1\.0\.1` requires Node `>=22`/u);
      assert.match(text, /declares `>=18`/u);
    });

    it("stays quiet when Node is compatible, unknown or undeclared", async () => {
      const analysis = await withDetails({ "1.0.1": { nodeEngine: ">=16" } });
      assert.doesNotMatch(
        hoverMarkdown(analysis, hoverContext),
        /requires Node/u
      );
      const incompatible = await withDetails({
        "1.0.1": { nodeEngine: ">=22" },
      });
      assert.doesNotMatch(
        hoverMarkdown(incompatible, {
          ...hoverContext,
          projectNodeEngine: undefined,
        }),
        /requires Node/u
      );
      assert.doesNotMatch(
        hoverMarkdown(await withDetails({}), hoverContext),
        /requires Node|License/u
      );
    });

    it("links the versions tab and the repository releases", async () => {
      const analysis = await withDetails({});
      const text = hoverMarkdown(
        {
          ...analysis,
          links: {
            ...analysis.links,
            releases: "https://github.com/o/r/releases",
          },
        },
        hoverContext
      );
      assert.match(
        text,
        /\[Versions\]\(https:\/\/www\.npmjs\.com\/package\/patchy\?activeTab=versions\)/u
      );
      assert.match(
        text,
        /\[Releases\]\(https:\/\/github\.com\/o\/r\/releases\)/u
      );
      assert.doesNotMatch(hoverMarkdown(analysis, hoverContext), /Releases/u);
    });
  });

  it("states that registry failures are not up-to-date results", async () => {
    const { get } = await analyzeAll();
    const text = hoverMarkdown(get("offline"), {
      now: NOW,
      prereleaseEnabled: false,
      showLatestHint: true,
    });
    assert.match(text, /not\*\* reported as up to date/u);
  });
});

describe("status and filters", () => {
  it("counts updates, blocked and vulnerable dependencies separately", async () => {
    const { analysis } = await analyzeAll();
    assert.equal(analysis.summary.vulnerable, 1);
    assert.equal(analysis.summary.blocked, 1);
    assert.equal(analysis.summary.errors, 1);
    const status = statusFor("npm", {
      kind: "ready",
      partial: analysis.partial,
      summary: analysis.summary,
    });
    assert.match(status.text, /npm \d+↑ 1✋ 1⚠/u);
    assert.equal(status.tone, "warning");
    assert.equal(statusFor("pnpm", { kind: "loading" }).tone, "loading");
    assert.equal(
      statusFor("pnpm", { kind: "error", message: "x" }).tone,
      "error"
    );
    assert.match(
      statusFor("npm", {
        kind: "ready",
        partial: false,
        summary: {
          advisories: 0,
          blocked: 0,
          errors: 0,
          total: 1,
          unsupported: 0,
          updates: 0,
          vulnerable: 0,
        },
      }).text,
      /✓/u
    );
  });

  it("filters dashboard items", async () => {
    const { get } = await analyzeAll();
    assert.equal(
      matchesFilters(get("vuln"), { ...NO_FILTERS, vulnerableOnly: true }),
      true
    );
    assert.equal(
      matchesFilters(get("current"), { ...NO_FILTERS, vulnerableOnly: true }),
      false
    );
    assert.equal(
      matchesFilters(get("vite"), { ...NO_FILTERS, blockedOnly: true }),
      true
    );
    assert.equal(
      matchesFilters(get("major"), { ...NO_FILTERS, severities: ["major"] }),
      true
    );
    assert.equal(
      matchesFilters(get("patchy"), { ...NO_FILTERS, severities: ["major"] }),
      false
    );
    assert.equal(
      matchesFilters(get("current"), { ...NO_FILTERS, updatesOnly: true }),
      false
    );
  });
});

describe("helpers", () => {
  it("escapes and clips untrusted text", () => {
    assert.equal(
      escapeMarkdown("[x](http://e) <b>*"),
      "\\[x\\]\\(http://e\\) \\<b\\>\\*".replace("http://e", "http://e")
    );
    assert.equal(clip("a   b\n c", 10), "a b c");
    assert.equal(clip("x".repeat(20), 5), "xxxx…");
    assert.equal(safeLink("a", "javascript:alert(1)"), "a");
    assert.equal(safeLink("a", "https://e.com/a\nb"), "a");
    assert.match(safeLink("a", "https://e.com/x)y"), /x%29y/u);
  });

  it("formats relative time", () => {
    assert.equal(formatRelativeTime("2026-01-09T23:59:30Z", NOW), "just now");
    assert.equal(
      formatRelativeTime("2026-01-09T22:00:00Z", NOW),
      "2 hours ago"
    );
    assert.equal(formatRelativeTime("2025-01-01T00:00:00Z", NOW), "1 year ago");
    assert.equal(formatRelativeTime("garbage", NOW), undefined);
    assert.equal(formatRelativeTime(undefined, NOW), undefined);
  });
});

describe("codeActionsFor", () => {
  const lensContext = { prereleaseEnabled: false, showUpToDate: false };

  it("offers an update and an update with install for a dependency with a target", async () => {
    const { get } = await analyzeAll();
    const patchy = get("patchy");
    assert.deepEqual(
      codeActionsFor(patchy, lensContext).map(
        ({ args, command, preferred, title }) => ({
          args,
          command,
          preferred,
          title,
        })
      ),
      [
        {
          args: [patchy.key, "1.0.1"],
          command: "manifestLens.updateDependency",
          preferred: true,
          title: "Update patchy to 1.0.1",
        },
        {
          args: [patchy.key, "1.0.1"],
          command: "manifestLens.updateDependencyAndInstall",
          preferred: false,
          title: "Update patchy to 1.0.1 and install",
        },
      ]
    );
  });

  it("offers the reviewed update when the target is blocked, and the compatible version when there is one", async () => {
    const { get } = await analyzeAll();
    const vite = get("vite");
    const blocked = codeActionsFor(vite, lensContext);
    assert.deepEqual(
      blocked.map(({ command, title }) => ({ command, title })),
      [
        {
          command: "manifestLens.updateBlockedDependency",
          title: "Update vite to 7.0.0 (blocked, review the conflicts first)",
        },
      ]
    );
    assert.equal(blocked[0]?.preferred, false);
    const withFallback = codeActionsFor(
      {
        ...vite,
        compatibleCandidate: {
          potentiallyBreaking: false,
          severity: "minor",
          version: "6.5.0",
        },
      },
      lensContext
    );
    assert.ok(
      withFallback.some(
        (action) => action.title === "Update vite to 6.5.0 (compatible)"
      )
    );
  });

  it("offers nothing for up-to-date, failing or unsupported dependencies", async () => {
    const { get } = await analyzeAll();
    for (const name of ["current", "offline", "ws"]) {
      assert.deepEqual(codeActionsFor(get(name), lensContext), [], name);
    }
  });

  it("offers a prerelease only when prereleases are enabled", async () => {
    const { get } = await analyzeAll();
    const tagless = get("tagless");
    const titles = (enabled: boolean) =>
      codeActionsFor(tagless, {
        ...lensContext,
        prereleaseEnabled: enabled,
      }).map((action) => action.title);
    assert.ok(titles(true).some((title) => title.includes("prerelease")));
    assert.ok(!titles(false).some((title) => title.includes("prerelease")));
  });
});
