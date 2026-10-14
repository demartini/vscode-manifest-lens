# Configuration

All settings live under the `manifestLens` namespace. Invalid values never raise errors; each field falls back to its documented default.

| Setting | Default | Description |
| --- | --- | --- |
| `manifestLens.registry` | `https://registry.npmjs.org/` | npm-compatible registry. `https://` only (plain `http://` for loopback hosts). No credentials are sent. **Ignored in untrusted workspaces.** |
| `manifestLens.cacheTimeout` | `300000` | Registry metadata cache TTL (ms). |
| `manifestLens.showVersionStatus` | `true` | Inline end-of-line annotations. |
| `manifestLens.annotations.minimumUpdateSeverity` | `patch` | Hide update annotations below `patch` / `minor` / `major`. Advisories, deprecations, blockers and errors always show. |
| `manifestLens.showLatestVersionHint` | `true` | Latest published / compatible versions in the hover. |
| `manifestLens.codeLens.enabled` | `true` | Master switch for CodeLens entries. |
| `manifestLens.codeLens.showUpToDate` | `false` | Also show lenses for dependencies that are up to date. |
| `manifestLens.codeLens.showOnStartup` | `true` | Show suggestions when the window opens (toggle per session from the editor toolbar). |
| `manifestLens.minimumReleaseAge` | `0` | Minutes a version must have been published before it is suggested (`1440` = one day, `0` = off). Newer versions that are too young are listed in the hover as held back. Versions without a known publication date are never held back. The project's package manager policy is applied too (see below); the stricter of the two wins. |
| `manifestLens.prerelease.enabled` | `false` | Suggest prereleases (never replaces a stable version silently). |
| `manifestLens.prerelease.tags` | `[]` | Only prereleases whose first identifier is listed (`beta`, `rc`, `next`…). Empty = any. |
| `manifestLens.security.enabled` | `true` | Query OSV for advisories. |
| `manifestLens.security.warnBeforeAdvisoryUpgrade` | `true` | Confirm before applying a version with known advisories. |
| `manifestLens.peerDependencies.enabled` | `true` | Peer compatibility analysis. |
| `manifestLens.packageManager` | `auto` | `auto` / `npm` / `pnpm` / `yarn` / `bun`. **Ignored in untrusted workspaces.** |
| `manifestLens.updatePolicy` | `conservative` | `conservative` excludes confirmed blockers from bulk updates; `force` includes them after an explicit warning. |
| `manifestLens.analysis.concurrency` | `4` | Concurrent registry / OSV / filesystem lookups (1–16). |
| `manifestLens.analysis.timeout` | `10000` | Per-request timeout (ms, 1000–120000). |
| `manifestLens.workspace.enabled` | `true` | Workspace-aware analysis (monorepos, catalogs, workspace packages, dashboard). |
| `manifestLens.logging.level` | `warn` | `off` / `error` / `warn` / `info` / `debug`. |

## Scope and trust

Settings that change where requests go or which program runs (`registry`, `packageManager`) are declared as _restricted configurations_: until a workspace is trusted, only the user-level value (or the default) is used. Package manager commands never run in an untrusted workspace.

## Commands

See the _Manifest Lens_ category in the Command Palette. Context-menu and CodeLens actions:

| Action | Effect |
| --- | --- |
| Resolved as _X_ | Rewrite the specifier to the installed version, preserving the operator. Saves; does not install. |
| Update to _X_ | Rewrite the specifier and save. Does not install. |
| Install Update | Same edit, then run the detected package manager's `install`. |
| Install Blocked Update | Shows every conflict and requires explicit confirmation. Offers `--legacy-peer-deps` only for npm, as an explicit opt-in. |

## Minimum release age from the package manager

Besides `manifestLens.minimumReleaseAge`, Manifest Lens reads the minimum release age the project's detected package manager is configured with, so it does not suggest a version the manager would refuse to install. The stricter of the two applies, and packages the manager excludes are exempt from its part only.

| Manager | File (install root) | Setting | Unit |
| --- | --- | --- | --- |
| pnpm | `pnpm-workspace.yaml` | `minimumReleaseAge`, `minimumReleaseAgeExclude` | minutes |
| Bun | `bunfig.toml` | `[install]` `minimumReleaseAge`, `minimumReleaseAgeExcludes` | seconds |
| npm | `.npmrc` | `min-release-age` | days |
| Yarn | `.yarnrc.yml` | `npmMinimalAgeGate`, `npmPreapprovedPackages` | minutes, or one value like `90m`, `12h`, `3d`, `1w` |

Only an explicit setting is read: defaults that a newer manager version applies on its own are not detected. For Yarn, preapproved package names and globs are honoured; descriptors such as `lodash@npm:^4` are ignored, so that package stays gated.
