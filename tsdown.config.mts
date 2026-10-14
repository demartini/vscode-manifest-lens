import { resolve } from "node:path";

import { defineConfig } from "tsdown";

export default defineConfig({
  // jsonc-parser's default (UMD) entry loads its internals with dynamic requires,
  // which cannot be bundled; its ESM build can.
  alias: {
    "jsonc-parser": resolve("node_modules/jsonc-parser/lib/esm/main.js"),
  },
  clean: true,
  deps: {
    // The .vsix ships without node_modules, so runtime dependencies must be inlined.
    alwaysBundle: ["jsonc-parser", "semver", "yaml", "zod"],
    neverBundle: ["vscode"],
  },
  entry: ["src/extension.ts"],
  format: "cjs",
  outDir: "dist",
  platform: "node",
  sourcemap: !process.argv.includes("--minify"),
});
