import { join } from "node:path";

import {
  type ManagerReleaseAge,
  parseBunReleaseAge,
  parseNpmReleaseAge,
  parsePnpmReleaseAge,
} from "../../domain/package-manager/release-age";
import type { PackageManagerDetection } from "../../domain/package-manager/types";
import type { FileProbe } from "./detect";

const FILES: Readonly<
  Partial<
    Record<
      PackageManagerDetection["manager"],
      {
        names: readonly string[];
        parse: (text: string) => ManagerReleaseAge | undefined;
      }
    >
  >
> = {
  bun: { names: ["bunfig.toml"], parse: parseBunReleaseAge },
  npm: { names: [".npmrc"], parse: parseNpmReleaseAge },
  pnpm: {
    names: ["pnpm-workspace.yaml", "pnpm-workspace.yml"],
    parse: parsePnpmReleaseAge,
  },
};

/**
 * The minimum release age the project's package manager is configured with, read from
 * the install root. Yarn is not read: its setting is only documented for unreleased versions.
 */
export async function readManagerReleaseAge(
  probe: FileProbe,
  detection: Pick<PackageManagerDetection, "manager" | "root">
): Promise<ManagerReleaseAge | undefined> {
  const source = FILES[detection.manager];
  for (const name of source?.names ?? []) {
    const text = await probe.readText(join(detection.root, name));
    if (text !== undefined) {
      return source?.parse(text);
    }
  }
  return undefined;
}
