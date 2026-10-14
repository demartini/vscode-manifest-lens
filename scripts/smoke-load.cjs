"use strict";
// Loads dist/extension.cjs in plain Node with a stand-in for the `vscode` module.
// It fails if the bundle needs any module that the .vsix does not ship.
const Module = require("node:module");
const path = require("node:path");

const standIn = () =>
  new Proxy(function standIn() {}, {
    apply: () => standIn(),
    construct: () => standIn(),
    get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : standIn()),
  });

// Bundler interop copies the module's own keys, so the stand-in needs real ones.
const vscodeStandIn = Object.fromEntries(
  [
    "CodeAction",
    "CodeActionKind",
    "CodeLens",
    "ConfigurationTarget",
    "DecorationRangeBehavior",
    "Diagnostic",
    "DiagnosticSeverity",
    "DiagnosticTag",
    "EventEmitter",
    "ExtensionMode",
    "Hover",
    "MarkdownString",
    "Position",
    "ProgressLocation",
    "QuickPickItemKind",
    "Range",
    "StatusBarAlignment",
    "ThemeColor",
    "ThemeIcon",
    "TreeItem",
    "TreeItemCollapsibleState",
    "Uri",
    "WorkspaceEdit",
    "commands",
    "env",
    "extensions",
    "languages",
    "window",
    "workspace",
  ].map((name) => [name, standIn()])
);

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === "vscode"
    ? vscodeStandIn
    : originalLoad.call(this, request, ...rest);
};

try {
  const bundle = require(path.resolve(__dirname, "../dist/extension.cjs"));
  if (typeof bundle.activate !== "function") {
    throw new Error("the bundle does not export activate()");
  }
  process.stdout.write("Bundle loads and exports activate().\n");
} catch (error) {
  process.stderr.write(`The bundle failed to load: ${error && error.stack}\n`);
  process.exit(1);
}
