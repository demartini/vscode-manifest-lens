import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@vscode/test-cli";

// IPC socket paths are limited to ~100 characters on macOS/Linux, so the user
// data directory must live in a short path regardless of where the repo is.
const shortTmp = process.platform === "win32" ? tmpdir() : "/tmp";
const userData = join(shortTmp, "pl-vscode-test", "user");

export default defineConfig([
  {
    files: "out/test/extension/**/*.test.js",
    label: "extension",
    launchArgs: ["--disable-extensions", `--user-data-dir=${userData}`],
    mocha: { timeout: 60_000, ui: "bdd" },
    version: "stable",
    workspaceFolder: "./test/fixtures/workspace",
  },
]);
