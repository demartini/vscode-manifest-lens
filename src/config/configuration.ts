import * as vscode from "vscode";

import {
  type ManifestLensConfig,
  parseConfiguration,
} from "./configuration-schema";

export const CONFIG_SECTION = "manifestLens";

/**
 * Settings that influence where requests go or which programs run are ignored
 * (reset to defaults) until the workspace is trusted.
 */
export function readConfiguration(): ManifestLensConfig {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw: Record<string, unknown> = {};
  for (const key of [
    "analysis",
    "annotations",
    "cacheTimeout",
    "codeLens",
    "logging",
    "packageManager",
    "peerDependencies",
    "prerelease",
    "registry",
    "security",
    "showLatestVersionHint",
    "showVersionStatus",
    "updatePolicy",
    "workspace",
  ]) {
    const inspected = configuration.inspect(key);
    const trustedOnly = key === "registry" || key === "packageManager";
    raw[key] =
      trustedOnly && !vscode.workspace.isTrusted
        ? (inspected?.globalValue ?? inspected?.defaultValue)
        : configuration.get(key);
  }
  return parseConfiguration(raw);
}

export const affectsConfiguration = (
  event: vscode.ConfigurationChangeEvent
): boolean => event.affectsConfiguration(CONFIG_SECTION);
