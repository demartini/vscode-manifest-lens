import * as vscode from "vscode";

import { manifestFormatOf } from "../../domain/manifest/parse";

export const SUPPORTED_SELECTOR: vscode.DocumentSelector = [
  { pattern: "**/package.json", scheme: "file" },
  { pattern: "**/pnpm-workspace.{yaml,yml}", scheme: "file" },
  { pattern: "**/.yarnrc.yml", scheme: "file" },
];

const IGNORED_PATH = /[\\/](?:node_modules|\.git|\.yarn)[\\/]/u;

/** Installed dependencies contain thousands of manifests that are never user-edited. */
export const isIgnoredManifestPath = (uri: string): boolean =>
  IGNORED_PATH.test(decodeURIComponent(uri));

export const isManifestDocument = (document: vscode.TextDocument): boolean =>
  document.uri.scheme === "file" &&
  manifestFormatOf(document.uri.path) !== undefined &&
  !isIgnoredManifestPath(document.uri.path);

export const isPackageJson = (document: vscode.TextDocument): boolean =>
  isManifestDocument(document) &&
  manifestFormatOf(document.uri.path) === "package-json";

export const fsPathOf = (uri: string): string | undefined => {
  const parsed = vscode.Uri.parse(uri);
  return parsed.scheme === "file" ? parsed.fsPath : undefined;
};

export const dirOf = (uri: string): string | undefined => {
  const path = fsPathOf(uri);
  return path === undefined ? undefined : path.replace(/[\\/][^\\/]*$/u, "");
};
