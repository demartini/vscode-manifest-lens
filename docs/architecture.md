# Architecture

Manifest Lens is built around **one analysis engine that every UI surface consumes**. CodeLens, hover, inline annotations, diagnostics, the status bar and the dashboard never compute versions, advisories or peer compatibility themselves; they render the same `ManifestAnalysis` objects.

```text
┌──────────────────────────────────────────────────┐
│ VS Code adapter (src/vscode, src/extension.ts)   │
│ CodeLens · Quick fixes · Hover · Decorations ·   │
│ Diagnostics                                      │
│ Status bar · Tree view · Commands · Editor events│
├──────────────────────────────────────────────────┤
│ Presentation (src/presentation)                  │
│ Pure view models: annotations, lenses, hover     │
│ markdown, status text, dashboard filters         │
├──────────────────────────────────────────────────┤
│ Application (src/application)                    │
│ ManifestAnalyzer · UpdateExecutor · ports        │
├──────────────────────────────────────────────────┤
│ Domain (src/domain)                              │
│ Specifiers · version selection · manifests ·     │
│ advisories · peer analysis · update plans        │
├──────────────────────────────────────────────────┤
│ Infrastructure (src/infrastructure)              │
│ HTTP · npm registry · OSV · node_modules ·       │
│ package managers · processes · cache · logging   │
└──────────────────────────────────────────────────┘
```

Dependencies point inward: `vscode / infrastructure → application → domain`. The domain layer imports neither `vscode`, nor `node:fs`, nor the network. The application layer talks to the outside world only through the ports in `src/application/ports.ts` (`RegistryPort`, `AdvisoryPort`, `InstalledPackagesPort`, `ManifestEditorPort`, `Clock`).

## Core data flow

1. `WorkspaceIndex` discovers `package.json`, `pnpm-workspace.yaml` and `.yarnrc.yml` files (never inside `node_modules`), parses them and keeps the index fresh through file watchers and document events.
2. `AnalysisService` owns one _slot_ per manifest. Requests are debounced; a newer request aborts the older one; a result is stored only if its generation is still current **and** the document version it was computed for is still the document's version. Failed refreshes keep the previous analysis, flagged stale.
3. `ManifestAnalyzer` (application) turns a parsed manifest into a `ManifestAnalysis`: registry metadata → installed versions → version selection → peer analysis → OSV advisories → per dependency `DependencyAnalysis` + a summary.
4. Providers read the analysis and map it onto the _current_ document text (`DocumentViews`), so ranges stay correct while the user types and results for a changed specifier are dropped rather than shown wrongly.
5. Updates go through `UpdateExecutor`: plan → re-read the manifest → relocate each declaration and verify its specifier still matches the analyzed one → apply minimal span edits through the editor port → save → (optionally) install → re-analyze. A single stale declaration aborts the whole transaction before any write.

## Version semantics

| Concept | Meaning |
| --- | --- |
| Declared specifier | The string in the manifest (`^1.2.3`, `npm:x@~2`, `catalog:`, …). |
| Installed version | Read from the nearest `node_modules/<name>/package.json`. May be absent. |
| Resolved version | The newest stable release the _current specifier_ admits. |
| Latest published | The `latest` dist-tag (or newest stable release). |
| Base version | What updates are measured from: the installed version when it satisfies the specifier, otherwise the declared minimum. |
| Target | The newest stable release above the base version (deprecated releases are skipped while alternatives exist). |

Update severity is the literal semver distance between base and candidate. `0.x` releases are _classified literally_ (`0.3.0 → 0.4.0` is `minor`) and additionally flagged `potentiallyBreaking`, because semver treats minor bumps below 1.0 as breaking. Severity labels are never a guarantee of compatibility.

Prereleases are suggested only when enabled, only when newer than every stable candidate, and only for the configured prerelease identifiers.

### Minimum release age

A release younger than the minimum is not a candidate: it is excluded from `target`, `major`, `minor` and `patch` and listed in `selection.heldBack`, which the hover reports. The limit is computed per version as the stricter of `manifestLens.minimumReleaseAge` and the project's package manager policy (`readManagerReleaseAge`, which reads `pnpm-workspace.yaml`, `bunfig.toml`, `.npmrc` or `.yarnrc.yml` from the detected install root). The manager's exclusions (`isExcludedFromReleaseAge`: names, globs and exact versions) lift only the manager's part, never the user's own setting. A release without a publication date is never held back, because its age cannot be judged. Only explicit settings are read, not defaults a newer manager version applies by itself.

### Release details

`DependencyAnalysis.releaseDetails` carries the license and `engines.node` of the current version and of every update candidate. The hover shows the license, warns when the update changes it, and warns when the update needs a Node version the project's own `engines.node` does not cover. That check is a subset test (`nodeCompatibility`): every Node version the project declares must be admitted by the release. Missing or unparsable ranges are unknown and never produce a warning.

### Specifier rewriting

`rewriteSpecifier` preserves the user's convention: `^1.2.3 → ^2.0.0`, `~1.2.3 → ~2.0.0`, `1.x → 2.x`, `npm:react@^18 → npm:react@^19`. It returns nothing (and the UI offers no action) for tags, protocols (`workspace:`, `file:`, `link:`, git/URL) and single upper bounds (`<2`) because any rewrite there would silently change meaning.

Complex ranges (`src/domain/version/range-rewrite.ts`) are widened just enough to admit the target, keeping the user's spacing: comparator sets raise a major-aligned `<N` (or `<=V`) upper bound, hyphen ranges move their upper bound, and unions replace their newest alternative (or, for `peerDependencies`, gain a new one). The target must be above the range; a downgrade, a range that already admits the target, or an upper bound with no obvious widening is not rewritten. Every rewrite is checked with `semver.satisfies` before it is returned, so a rewrite that would not admit the target can never reach the manifest.

## Peer dependency analysis

For every candidate version the analyzer evaluates:

- **Blockers** – installed (or, if not installed, declared-range-resolved) dependencies whose own `peerDependencies` reject the candidate. Evidence is recorded (`installed` / `declared`).
- **The candidate's own peers** – its `peerDependencies` against the versions in use.
- **Resolutions** – whether a newer release of the blocker relaxes the range, and the resulting _coordinated upgrade_.

Classification: `blocked` (a confirmed, non-optional incompatibility), `potential-conflict` (optional peers, unevaluable ranges, missing non-optional peers), `compatible` (nothing relevant found) and `unknown` (data for a relevant package could not be gathered). Missing metadata is never reported as compatibility.

## Security semantics

Advisories come from OSV. The client batches `(name, version)` queries, then fetches each distinct record once. The domain re-checks every record against the queried version using the OSV event model (`introduced`, `fixed`, `last_affected`, `limit`, explicit `versions`) and merges aliases (GHSA/CVE) so counts are _distinct advisories_.

- The version checked is the installed version; if none is installed it is the declared minimum and the UI says so. A range is never assumed vulnerable because one possible version is.
- A lookup failure is `unknown`, shown as such, and never as a clean result.
- An available fix is not assumed peer-compatible, and advisories with no fix stay visible.
- Advisories that a candidate would **introduce** are reported separately and trigger a confirmation.

## Status bar counting rules

`npm 5↑ 1✋ 2⚠`: `↑` dependencies with a non-blocked update; `✋` dependencies whose newest update has a confirmed peer conflict; `⚠` dependencies whose _current_ version has at least one advisory (one count per dependency however many advisories it has); `✗` dependencies whose declared version no published release satisfies (a version newer than the latest release, or a pin that does not exist; such a dependency is never reported as up to date and may also have an update, so it can count under `↑` too); `?` dependencies that could not be checked. The tooltip also shows the number of distinct advisories.

## Caching

| Data | Default TTL | Notes |
| --- | --- | --- |
| Registry packuments | 5 min (`manifestLens.cacheTimeout`) | LRU (500), in-flight de-duplication, failures remembered 60 s |
| OSV queries and records | 15 min | LRU (5000) |
| Download counts | 1 h | hover only, default registry only |
| Installed packages | until a lockfile changes or an install finishes |  |

A shared in-flight load is aborted only when every waiting caller has aborted. `clear()` detaches in-flight loads so a stale response can never repopulate the cache.
