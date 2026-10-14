import { dirname, join } from "node:path";

import {
  PACKAGE_MANAGERS,
  type PackageManagerDetection,
  type PackageManagerName,
} from "../../domain/package-manager/types";

export interface FileProbe {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | undefined>;
}

const LOCKFILES: readonly (readonly [string, PackageManagerName])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["pnpm-workspace.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  // Yarn 2+ configuration: present before the first install creates `yarn.lock`.
  [".yarnrc.yml", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

export const parsePackageManagerField = (
  value?: string
): PackageManagerName | undefined => {
  const name = value?.split("@")[0];
  return PACKAGE_MANAGERS.find((candidate) => candidate === name);
};

const fieldOf = async (
  probe: FileProbe,
  dir: string
): Promise<PackageManagerName | undefined> => {
  const text = await probe.readText(join(dir, "package.json"));
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "packageManager" in parsed
    ) {
      const field = parsed.packageManager;
      return typeof field === "string"
        ? parsePackageManagerField(field)
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Determines the package manager and install root for a manifest. An explicit
 * setting wins for the manager but the root is still derived from lockfiles, so
 * monorepo installs run where the lockfile lives rather than in the package.
 */
export async function detectPackageManager(options: {
  configured: PackageManagerName | "auto";
  manifestDir: string;
  /** The search never goes above this directory (the workspace folder). */
  boundary: string;
  probe: FileProbe;
}): Promise<PackageManagerDetection> {
  const { configured, manifestDir, boundary, probe } = options;
  let dir = manifestDir;
  let fieldFallback: PackageManagerDetection | undefined;
  for (;;) {
    for (const [file, manager] of LOCKFILES) {
      if (await probe.exists(join(dir, file))) {
        return {
          evidence: `${file} found in ${dir}`,
          manager: configured === "auto" ? manager : configured,
          root: dir,
        };
      }
    }
    const field = await fieldOf(probe, dir);
    if (field && !fieldFallback) {
      fieldFallback = {
        evidence: `packageManager field in ${dir}`,
        manager: configured === "auto" ? field : configured,
        root: dir,
      };
    }
    const parent = dirname(dir);
    if (dir === boundary || parent === dir || !dir.startsWith(boundary)) {
      break;
    }
    dir = parent;
  }
  if (fieldFallback) {
    return fieldFallback;
  }
  return {
    evidence:
      configured === "auto"
        ? "no lockfile found; defaulting to npm"
        : "configured explicitly",
    manager: configured === "auto" ? "npm" : configured,
    root: manifestDir,
  };
}
