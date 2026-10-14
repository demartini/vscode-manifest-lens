import { parsePackageJson } from "./package-json";
import { parsePnpmWorkspace } from "./pnpm-workspace";
import type { ManifestFormat, ParsedManifest } from "./types";

/** Returns the manifest format for a file path, or undefined for unrelated files. */
export function manifestFormatOf(path: string): ManifestFormat | undefined {
  const name = path.split(/[\\/]/u).at(-1);
  if (name === "package.json") {
    return "package-json";
  }
  if (name === "pnpm-workspace.yaml" || name === "pnpm-workspace.yml") {
    return "pnpm-workspace";
  }
  return undefined;
}

/** Parses manifest text according to the format implied by the file name. */
export function parseManifestText(
  path: string,
  text: string
): ParsedManifest | undefined {
  const format = manifestFormatOf(path);
  if (format === "package-json") {
    return parsePackageJson(text);
  }
  return format === "pnpm-workspace" ? parsePnpmWorkspace(text) : undefined;
}
