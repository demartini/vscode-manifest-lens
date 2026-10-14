<div align="center">
  <img align="center" src="https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/logo.png" alt="Logo" width="200">
</div>

<h1 align="center">Manifest Lens</h1>

<p align="center">Understand, maintain and safely upgrade your dependencies without leaving the manifest: version updates, peer dependency conflicts, OSV security advisories and a dependency dashboard.</p>

<div align="center">

[![VS Marketplace][vs-marketplace-shield]][vs-marketplace-url] [![Open VSX][open-vsx-shield]][open-vsx-url] [![Stargazers][stars-shield]][stars-url] [![Issues][issues-shield]][issues-url] [![License][license-shield]][license-url]

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/demo/overview.gif" alt="Manifest Lens analyzing a package.json: inline annotations, CodeLens and section summaries" width="900">
</p>

## Table of Contents <!-- omit in toc -->

- [About](#about)
- [Features](#features)
  - [Color-Coded Inline Annotations](#color-coded-inline-annotations)
  - [Peer Dependency Conflict Detection](#peer-dependency-conflict-detection)
  - [Rich Hover Tooltips](#rich-hover-tooltips)
  - [CodeLens Summaries and Actions](#codelens-summaries-and-actions)
  - [Vulnerability Detection](#vulnerability-detection)
  - [Status Bar](#status-bar)
  - [Sidebar Dashboard](#sidebar-dashboard)
  - [Safe, Workspace-Aware Edits](#safe-workspace-aware-edits)
- [Demo](#demo)
- [Getting Started](#getting-started)
- [How It Works](#how-it-works)
- [Supported Dependency Sections](#supported-dependency-sections)
- [Commands](#commands)
- [Settings](#settings)
- [Privacy and Security](#privacy-and-security)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

## About

Manifest Lens brings dependency intelligence directly into `package.json` and workspace catalog files. It shows available updates, detects peer dependency conflicts, flags known vulnerabilities and applies upgrades through a coordinated, transaction-style workflow, all without leaving the editor.

It never changes a manifest or runs an install silently: every write and every package manager invocation is the result of an explicit action. Data that could not be fetched is always shown as _unavailable_, never as "up to date" or "no vulnerabilities".

<p align="right">(<a href="#top">back to top</a>)</p>

## Features

### Color-Coded Inline Annotations

Each dependency line ends with a short status. Its color follows the most severe finding on that line and comes from your theme, so the squares below show the intent rather than exact shades:

| Color | Annotation | Meaning |
| --- | --- | --- |
| Green | 🟩 `✓ up to date` | The resolved version is the latest compatible release. |
| Blue | 🟦 `⬆ 4.18.1 (minor) — 6 months ago` | A minor or patch update is available, with its severity and age. |
| Yellow | 🟨 `⬆ 5.3.0 (major)` · `✋ 19.3.0 blocked by react-dom` · `⊘ deprecated` | A major update, an update blocked by a peer dependency, or a deprecated package. |
| Red | 🟥 `⚠ 4 advisories · ⬆ 4.18.1 (minor)` | Known vulnerabilities affect the resolved version. |
| Grey | ⬜ `⟳ checking…` | Analysis is still in progress, or the file type is unsupported. |

Annotations below the configured severity can be hidden with `manifestLens.annotations.minimumUpdateSeverity`.

### Peer Dependency Conflict Detection

Manifest Lens checks the installed dependents of a package, the candidate version's own peers and newer releases of the blocking packages. When a coordinated upgrade exists it proposes it, for example _"upgrade `react-dom` to 19.3.0 to unblock `react` 19.3.0"_. Confidence is lowered, and reported as `unknown` or `potential`, when a lockfile or `node_modules` is missing.

### Rich Hover Tooltips

Hover a dependency to see the declared, installed, resolved, latest and latest-compatible versions, the available updates by severity, the release age, monthly downloads, the license, deprecation notices, advisories with fixed versions and references, blockers and links to the package pages (npm, its versions tab and the repository releases). An update is flagged when it changes the license or needs a newer Node than your `engines.node` declares.

### CodeLens Summaries and Actions

Above each dependency: `Resolved as 18.3.1 | Update to 19.3.0 | Install Update`. For conflicts: `19.3.0 blocked by 1 dependency | Install Blocked Update`. Above each section, a summary lens such as `3 updates available · 2 blocked — Update all` updates every eligible dependency at once, after a review step in which you can uncheck anything.

The same updates are available as lightbulb quick fixes (`Ctrl+.` / `Cmd+.`) on a dependency line, for example `Update react to 19.3.0` and `Update react to 19.3.0 and install`, even when the CodeLens is turned off.

### Vulnerability Detection

Advisories come from [OSV](https://osv.dev) and are published as Problems-panel diagnostics linked to the declaration. Manifest Lens asks for confirmation before applying an update that would _introduce_ an advisory.

### Status Bar

A compact summary of the active manifest, for example `npm 5↑ 1✋ 2⚠`: the detected package manager, available updates, blocked updates and advisories.

### Sidebar Dashboard

A tree in the activity bar that lists manifests → sections → dependencies → details. It has per-package actions, bulk updates, patch-only, minor-only and major-only updates, and filters by update severity, vulnerability and blocked status.

### Safe, Workspace-Aware Edits

- Minimal text edits that preserve formatting, comments and range operators (`^`, `~`, `1.x`, aliases).
- Every edit is validated against the analyzed text, so concurrent changes are never overwritten.
- Monorepos, `workspace:` packages, npm aliases, `pnpm-workspace.yaml` and Yarn (`.yarnrc.yml`, Yarn 4.10+) catalogs, `catalog:` references and Bun catalogs are understood.
- npm, pnpm, Yarn and Bun are detected from the lockfile, and installs run from the lockfile's root.

<p align="right">(<a href="#top">back to top</a>)</p>

## Demo

| Hover Details | Safe Updates |
| :-: | :-: |
| ![Hover Details](https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/demo/hover.gif) | ![Safe Updates](https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/demo/update.gif) |
| **Peer Dependency Conflicts** | **Security Advisories** |
| ![Peer Dependency Conflicts](https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/demo/peer-conflicts.gif) | ![Security Advisories](https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/demo/security.gif) |
| **Bulk Updates** | **Workspace Catalogs** |
| ![Bulk Updates](https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/demo/bulk-update.gif) | ![Workspace Catalogs](https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/demo/catalogs.gif) |
| **Sidebar Dashboard** |  |
| ![Sidebar Dashboard](https://raw.githubusercontent.com/demartini/vscode-manifest-lens/main/.github/media/demo/dashboard.gif) |  |

<p align="right">(<a href="#top">back to top</a>)</p>

## Getting Started

1. Install **Manifest Lens** from the [VS Code Marketplace][vs-marketplace-url] (or [Open VSX][open-vsx-url]), or install a `.vsix` from the [releases page][releases-url]:

   ```sh
   code --install-extension demartini.manifest-lens
   ```

2. Open a folder that contains a `package.json` (or a `pnpm-workspace.yaml`). The extension activates automatically.
3. Open the manifest. Every dependency line gets an inline annotation, and CodeLens actions appear above it.
4. Hover a dependency for the full picture, or click a CodeLens to update it. Open the **Manifest Lens** view in the activity bar for a workspace-wide dashboard.

<p align="right">(<a href="#top">back to top</a>)</p>

## How It Works

1. **Discover.** Manifest Lens indexes the manifests in the workspace (`package.json`, `pnpm-workspace.yaml`), ignoring `node_modules`, and parses each one without losing its formatting or comments.
2. **Resolve.** For every declaration it determines the declared range, the installed version (from `node_modules`) and the version the range resolves to.
3. **Fetch.** Registry metadata comes from your npm-compatible registry and advisories from OSV. Results are cached, requests run with limited concurrency and a timeout, and failures are reported as _unavailable_.
4. **Analyze.** Updates are classified by severity, peer requirements are checked against installed dependents and candidate peers, and advisories are matched against the resolved version.
5. **Present.** The same analysis feeds the inline annotations, CodeLens, hover, Problems panel, status bar and dashboard, so they never disagree.
6. **Apply.** When you choose an update, Manifest Lens edits only the version text, optionally runs your package manager's install from the lockfile's root, and re-analyzes. Edits are verified against the analyzed text first, so a concurrent change aborts the update instead of being overwritten.

<p align="right">(<a href="#top">back to top</a>)</p>

## Supported Dependency Sections

| Source | Sections |
| --- | --- |
| `package.json` | `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` |
| `package.json` | `overrides` (npm), `resolutions` (Yarn), `pnpm.overrides` |
| `package.json` (Bun) | `catalog`, `catalogs` and `workspaces.catalog`, plus `catalog:` references |
| `pnpm-workspace.yaml` | `catalog` and named `catalogs`, plus `catalog:` references from member packages |
| `.yarnrc.yml` (Yarn 4.10+) | `catalog` and named `catalogs`, plus `catalog:` and `catalog:name` references from member packages |

Manifest Lens also understands `workspace:` packages and npm aliases (`npm:pkg@^1.0.0`). Complex ranges (`>=1 <2`, `||`), dist-tags and protocol specifiers are analyzed but not rewritten automatically.

<p align="right">(<a href="#top">back to top</a>)</p>

## Commands

All commands are in the **Manifest Lens** category.

| Command | Description |
| --- | --- |
| Check for dependency updates | Re-analyze the active manifest. |
| Refresh dependency data | Clear caches and re-fetch everything. |
| Show / Hide version suggestions | Toggle CodeLens suggestions (editor toolbar). |
| Show / Hide prerelease versions | Toggle prerelease suggestions (editor toolbar). |
| Update all dependencies to latest | Plan, review and apply every eligible update. Confirmed blockers are skipped by default. |
| Update dependencies (major / minor / patch only) | Apply only updates of the chosen severity. |
| Sort dependencies alphabetically | Sort dependency sections without touching comments or formatting. |
| Run install for this package.json | Run the detected package manager's install from the project root. |
| Open Manifest Lens dashboard | Focus the dashboard view. |
| Analyze workspace dependencies | Analyze every manifest in the workspace. |
| Check vulnerabilities | Analyze the workspace and summarize advisories. |
| Upgrade selected dependency / and install | Update one dependency, optionally followed by an install. |
| Resolve to installed version | Rewrite a specifier to the installed version without installing. |
| Upgrade blocked dependency | Review the conflicts and update after explicit confirmation. |
| Cancel active analysis or installation | Abort running work. |
| Show extension diagnostics and cache status | Print the state, a settings summary and cache sizes to the output channel. |
| Clear caches | Drop all cached registry, advisory and installed-package data. |

<p align="right">(<a href="#top">back to top</a>)</p>

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `manifestLens.registry` | `https://registry.npmjs.org/` | npm-compatible registry (HTTPS). Ignored in untrusted workspaces. |
| `manifestLens.cacheTimeout` | `300000` | Registry metadata cache TTL in ms. |
| `manifestLens.showVersionStatus` | `true` | Show inline annotations. |
| `manifestLens.annotations.minimumUpdateSeverity` | `patch` | Hide update annotations below this severity. |
| `manifestLens.showLatestVersionHint` | `true` | Show the latest versions in the hover. |
| `manifestLens.codeLens.enabled` | `true` | Show CodeLens entries. |
| `manifestLens.codeLens.showUpToDate` | `false` | Show lenses for up-to-date dependencies. |
| `manifestLens.codeLens.showOnStartup` | `true` | Show suggestions on startup. |
| `manifestLens.minimumReleaseAge` | `0` | Do not suggest versions published less than this many minutes ago. The pnpm, Bun, npm and Yarn settings of the project are honoured too (see [docs/configuration.md](docs/configuration.md)). |
| `manifestLens.prerelease.enabled` | `false` | Suggest prereleases. |
| `manifestLens.prerelease.tags` | `[]` | Restrict prereleases to these tags. |
| `manifestLens.security.enabled` | `true` | Check advisories with OSV. |
| `manifestLens.security.warnBeforeAdvisoryUpgrade` | `true` | Confirm updates that introduce advisories. |
| `manifestLens.peerDependencies.enabled` | `true` | Analyze peer dependency conflicts. |
| `manifestLens.packageManager` | `auto` | `auto`, `npm`, `pnpm`, `yarn` or `bun`. Ignored in untrusted workspaces. |
| `manifestLens.updatePolicy` | `conservative` | `conservative` skips confirmed blockers in bulk updates; `force` includes them after a warning. |
| `manifestLens.analysis.concurrency` | `4` | Number of concurrent lookups. |
| `manifestLens.analysis.timeout` | `10000` | Per-request timeout in ms. |
| `manifestLens.workspace.enabled` | `true` | Enable workspace-wide analysis and the dashboard. |
| `manifestLens.logging.level` | `warn` | Output channel verbosity. |

See [docs/configuration.md](docs/configuration.md) for details.

<p align="right">(<a href="#top">back to top</a>)</p>

## Privacy and Security

- **No telemetry.** Package names (and, for advisories, versions) are sent to your registry and to `api.osv.dev`. Manifest contents and source code never leave your machine, and no credentials are sent.
- **Explicit actions only.** Package manager commands run only after you ask for them, never in an untrusted workspace, with an argument array and no shell (Windows `.cmd` shims excepted, with constant arguments).
- **No silent flags.** `--legacy-peer-deps` is never added automatically; it is an explicit opt-in for npm.

Details: [docs/security.md](docs/security.md).

<p align="right">(<a href="#top">back to top</a>)</p>

## Known Limitations

- Peer analysis uses package metadata and cannot prove runtime compatibility. A missing lockfile or an incomplete `node_modules` lowers confidence (reported as `unknown` or `potential`, never as compatible).
- Vulnerability analysis covers the direct dependencies declared in the manifests; it is not a full transitive-dependency audit.
- Yarn Plug'n'Play installs have no `node_modules`, so installed versions are unknown and the declared minimum is used (and labeled as such).
- Private registries that require authentication are not supported, because credentials are deliberately never sent.
- Complex ranges (`>=1 <2`, `||`), tags and protocol specifiers are analyzed but not rewritten automatically.

<p align="right">(<a href="#top">back to top</a>)</p>

## Contributing

If you'd like to contribute, review our [contribution guidelines][contributing-url] and open an [issue][issues-url] or [pull request][pull-request-url].

<p align="right">(<a href="#top">back to top</a>)</p>

## Changelog

See [CHANGELOG][changelog-url] for a complete and human-readable history of changes.

<p align="right">(<a href="#top">back to top</a>)</p>

## License

Distributed under the MIT License. See [LICENSE][license-url] for details.

<p align="right">(<a href="#top">back to top</a>)</p>

[changelog-url]: https://github.com/demartini/vscode-manifest-lens/blob/main/CHANGELOG.md
[contributing-url]: https://github.com/demartini/.github/blob/main/CONTRIBUTING.md
[issues-shield]: https://img.shields.io/github/issues/demartini/vscode-manifest-lens.svg?style=for-the-badge&color=8bd5ca&labelColor=181926
[issues-url]: https://github.com/demartini/vscode-manifest-lens/issues
[license-shield]: https://img.shields.io/github/license/demartini/vscode-manifest-lens.svg?style=for-the-badge&color=8bd5ca&labelColor=181926
[license-url]: https://github.com/demartini/vscode-manifest-lens/blob/main/LICENSE
[open-vsx-shield]: https://img.shields.io/open-vsx/v/demartini/manifest-lens?style=for-the-badge&color=8bd5ca&labelColor=181926
[open-vsx-url]: https://open-vsx.org/extension/demartini/manifest-lens
[pull-request-url]: https://github.com/demartini/vscode-manifest-lens/pulls
[releases-url]: https://github.com/demartini/vscode-manifest-lens/releases
[stars-shield]: https://img.shields.io/github/stars/demartini/vscode-manifest-lens.svg?style=for-the-badge&color=8bd5ca&labelColor=181926
[stars-url]: https://github.com/demartini/vscode-manifest-lens/stargazers
[vs-marketplace-shield]: https://img.shields.io/github/package-json/v/demartini/vscode-manifest-lens?label=VS%20Marketplace&style=for-the-badge&color=8bd5ca&labelColor=181926
[vs-marketplace-url]: https://marketplace.visualstudio.com/items?itemName=demartini.manifest-lens
