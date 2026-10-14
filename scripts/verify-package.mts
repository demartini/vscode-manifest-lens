import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

/**
 * Validates the files that would be published in the .vsix: required files must
 * be present, and sources, tests, maps and secrets must not be.
 */
const required = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "dist/extension.cjs",
  "images/icon.png",
  "images/manifest-lens.svg",
];
const forbidden = [
  /^src\//u,
  /^test\//u,
  /^docs\//u,
  /^node_modules\//u,
  /\.map$/u,
  /\.ts$/u,
  /(^|\/)\.env/u,
  /\.vsix$/u,
];

const output = execFileSync("bunx", ["vsce", "ls", "--no-dependencies"], {
  encoding: "utf-8",
});
const files = output
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");

const missing = required.filter(
  (file) =>
    !files.some((candidate) => candidate.toLowerCase() === file.toLowerCase())
);
const unexpected = files.filter((file) =>
  forbidden.some((pattern) => pattern.test(file))
);

if (missing.length > 0 || unexpected.length > 0) {
  process.stderr.write(
    `Package validation failed.\nMissing: ${missing.join(", ") || "none"}\nUnexpected: ${unexpected.join(", ") || "none"}\n`
  );
  process.exit(1);
}
// The extension ships without node_modules: the bundle may only require
// "vscode" and Node.js built-ins, never a third-party package.
const bundle = readFileSync("dist/extension.cjs", "utf-8");
const requires = [
  ...bundle.matchAll(/\brequire\(\s*[`"']([^`"']+)[`"']\s*\)/gu),
].map((match) => match[1] ?? "");
const external = [...new Set(requires)].filter(
  (name) =>
    name !== "vscode" &&
    !name.startsWith("node:") &&
    !builtinModules.includes(name)
);
if (external.length > 0) {
  process.stderr.write(
    `The bundle requires modules that are not shipped: ${external.join(", ")}\n`
  );
  process.exit(1);
}
// Smoke test: actually load the bundle (see smoke-load.cjs) so a dependency that is
// not inlined fails here rather than on a user's machine.
try {
  execFileSync("node", ["scripts/smoke-load.cjs"], { stdio: "inherit" });
} catch {
  process.exit(1);
}
process.stdout.write(`Package contents verified (${files.length} files).\n`);
