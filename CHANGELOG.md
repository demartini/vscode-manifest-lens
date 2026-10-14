# Changelog

All notable changes to this project will be documented in this file. See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
