# Changelog

All notable changes to this project will be documented in this file. See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.2.0](https://github.com/demartini/vscode-manifest-lens/compare/v0.1.0...v0.2.0) (2026-10-14)

### Features

- **analysis:** hold back versions younger than a minimum release age ([fd9d097](https://github.com/demartini/vscode-manifest-lens/commit/fd9d09784a58a2ee1319778dac1e93842e0f8ad4))
- **analysis:** read Yarn's minimum release age from .yarnrc.yml ([4900cca](https://github.com/demartini/vscode-manifest-lens/commit/4900cca88af59ac327fd7c3400f87cbd6bbd3b61))
- **analysis:** respect the package manager's minimum release age ([a39bcd0](https://github.com/demartini/vscode-manifest-lens/commit/a39bcd0f90909af906b4a2653e0fa3c502532868))
- **domain:** rewrite unions, hyphen ranges and comparator sets ([86dae6b](https://github.com/demartini/vscode-manifest-lens/commit/86dae6b1f6a33446a8a498239e796a6c1e1d621f))
- **domain:** support Yarn catalogs in .yarnrc.yml ([4a9587a](https://github.com/demartini/vscode-manifest-lens/commit/4a9587a0b702efde168e59f722b6d3853ab3831f))
- **presentation:** show license, Node compatibility and release links in the hover ([1292654](https://github.com/demartini/vscode-manifest-lens/commit/12926546c0870ed7ffc20cbe7d077e7b96b2badb))
- **registry:** read the license and Node engine of each release ([f7bd351](https://github.com/demartini/vscode-manifest-lens/commit/f7bd351ab0188545c9d5fd26fb955273f4f92800))
- **vscode:** offer dependency updates as lightbulb quick fixes ([9d75e25](https://github.com/demartini/vscode-manifest-lens/commit/9d75e25015b304740ba9e9cbf07e92c279bb1c50))

## 0.1.0

### Features

- Inline dependency annotations, CodeLens actions (resolve, update, install, blocked update) and section summaries.
- Hover details with versions, age, downloads, deprecation, advisories and peer blockers.
- Peer dependency conflict analysis with coordinated-upgrade suggestions.
- OSV vulnerability detection with Problems-panel diagnostics and a confirmation before advisory-introducing updates.
- Status bar summary and a sidebar dashboard with filters, per-package and bulk actions.
- Support for `package.json` dependency sections, overrides/resolutions, pnpm catalogs, Bun catalogs (`catalog`, `catalogs`, `workspaces.catalog`), npm aliases and `workspace:` references.
- Syntax-preserving manifest edits with optimistic concurrency checks, and npm/pnpm/Yarn/Bun installs run from the lockfile root.
- Workspace Trust awareness: no package manager command runs in untrusted workspaces, and registry and package manager settings are restricted configurations.
