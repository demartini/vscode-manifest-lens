# Testing

All tests use Mocha, in line with the [VS Code extension testing guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension).

| Command | What it runs |
| --- | --- |
| `bun run test:unit` | Domain, application, presentation and infrastructure tests in plain Mocha (fast, no VS Code). Infrastructure tests use real local HTTP servers and child processes. |
| `bun run test` | Integration tests inside a real Extension Development Host through `@vscode/test-cli` / `@vscode/test-electron` against a local fake registry and OSV server and a fake package manager on `PATH`. |
| `bun run test:all` | Both. |
| `bun run test:coverage` | The extension suite with coverage (c8). |

The integration suite never touches the network: the registry URL points at a local server, the OSV endpoint is overridden through `MANIFEST_LENS_OSV_URL` (honoured only in `ExtensionMode.Test`) and `npm`/`pnpm`/`yarn`/`bun` are replaced by scripts that record their invocation.

Fixture manifests are generated per test under `test/fixtures/workspace/cases/` (git-ignored).
