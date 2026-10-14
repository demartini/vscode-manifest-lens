# Architecture

Manifest Lens is built around **one analysis engine that every UI surface consumes**. CodeLens, hover, inline annotations, diagnostics, the status bar and the dashboard never compute versions, advisories or peer compatibility themselves; they render the same `ManifestAnalysis` objects.

```text
┌──────────────────────────────────────────────────┐
│ VS Code adapter (src/vscode, src/extension.ts)   │
│ CodeLens · Hover · Decorations · Diagnostics     │
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

1. `WorkspaceIndex` discovers `package.json` / `pnpm-workspace.yaml` files (never inside `node_modules`), parses them and keeps the index fresh through file watchers and document events.
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

### Specifier rewriting

`rewriteSpecifier` preserves the user's convention: `^1.2.3 → ^2.0.0`, `~1.2.3 → ~2.0.0`, `1.x → 2.x`, `npm:react@^18 → npm:react@^19`. It returns nothing (and the UI offers no action) for tags, protocols (`workspace:`, `file:`, `link:`, git/URL), complex ranges (`>=1 <2`, `||`) and upper bounds (`<2`) because any rewrite there would silently change meaning.

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

`npm 5↑ 1✋ 2⚠`: `↑` dependencies with a non-blocked update; `✋` dependencies whose newest update has a confirmed peer conflict; `⚠` dependencies whose _current_ version has at least one advisory (one count per dependency however many advisories it has); `?` dependencies that could not be checked. The tooltip also shows the number of distinct advisories.

## Caching

| Data | Default TTL | Notes |
| --- | --- | --- |
| Registry packuments | 5 min (`manifestLens.cacheTimeout`) | LRU (500), in-flight de-duplication, failures remembered 60 s |
| OSV queries and records | 15 min | LRU (5000) |
| Download counts | 1 h | hover only, default registry only |
| Installed packages | until a lockfile changes or an install finishes |  |

A shared in-flight load is aborted only when every waiting caller has aborted. `clear()` detaches in-flight loads so a stale response can never repopulate the cache.
