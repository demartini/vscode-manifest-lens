# Security and privacy

## Network destinations

| Destination | When | Data sent |
| --- | --- | --- |
| The configured registry (default `registry.npmjs.org`) | Analysis | Package names in the URL path. No manifest contents, no credentials. |
| `api.osv.dev` | Analysis, if `manifestLens.security.enabled` | Package names and versions. |
| `api.npmjs.org` | Hover over a dependency, default registry only | Package name. |

No telemetry is collected. Requests carry a `User-Agent` of `manifest-lens-vscode` and never an `Authorization` header or cookies. URLs must be `https://` (plain `http://` only for loopback hosts) and must not embed credentials; response bodies are size-limited and validated with schemas before use.

## Package manager configuration files

To honour the project's minimum release age, the extension reads one local file from the install root of the detected package manager: `pnpm-workspace.yaml`, `bunfig.toml`, `.npmrc` or `.yarnrc.yml`. Only the release age keys (and their exclusion lists) are extracted. Registry settings and credentials in those files, such as `_authToken`, are never read or used, and nothing from them is logged or sent anywhere. A malformed file is ignored.

## Process execution

- Only install commands are run, and only after an explicit user action (lens, command, or dashboard action).
- Commands are launched with an argument array (`child_process.spawn`) and no shell. The single exception is Windows, where `npm`/`pnpm`/`yarn`/`bun` are `.cmd` shims that require a shell; there the executable is one of four constants and the arguments come from a fixed allow-list (`install`, optionally `--legacy-peer-deps` for npm). No package name, path or setting value reaches a command line.
- Nothing runs in an untrusted workspace; one install at a time per project root; installs are cancellable.
- `--legacy-peer-deps` is never injected automatically; it is an opt-in choice in the blocked-update dialog.

## Manifest safety

- Edits are minimal text-span replacements, validated against the text expected at that span immediately before writing, so concurrent edits are detected instead of overwritten.
- Lockfiles are never modified by the extension.
- Saving a manifest that has unsaved changes asks first.

## Untrusted data

Registry and OSV text (descriptions, deprecation notices, advisory summaries) is escaped and length-limited before it is rendered as Markdown; only `http(s)` links are rendered; hover command links are limited to two update commands.

## Logging

The `Manifest Lens` output channel redacts bearer tokens, `_authToken`-style values, URL credentials and common token formats. The default level is `warn`.
