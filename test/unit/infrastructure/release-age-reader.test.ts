import * as assert from "node:assert/strict";

import type { PackageManagerName } from "../../../src/domain/package-manager/types";
import type { FileProbe } from "../../../src/infrastructure/package-manager/detect";
import { readManagerReleaseAge } from "../../../src/infrastructure/package-manager/release-age-reader";

const probeOf = (files: Record<string, string>): FileProbe => ({
  exists: async (path) => path in files,
  readText: async (path) => files[path],
});

const detection = (manager: PackageManagerName) => ({ manager, root: "/r" });

describe("readManagerReleaseAge", () => {
  it("reads the configuration file of the detected package manager", async () => {
    const files = {
      "/r/.npmrc": "min-release-age=1",
      "/r/bunfig.toml": "[install]\nminimumReleaseAge = 7200",
      "/r/.yarnrc.yml": "npmMinimalAgeGate: 3d",
      "/r/pnpm-workspace.yaml": "minimumReleaseAge: 2880",
    };
    const probe = probeOf(files);
    assert.equal(
      (await readManagerReleaseAge(probe, detection("pnpm")))?.minimumMinutes,
      2880
    );
    assert.equal(
      (await readManagerReleaseAge(probe, detection("bun")))?.minimumMinutes,
      120
    );
    assert.equal(
      (await readManagerReleaseAge(probe, detection("npm")))?.minimumMinutes,
      1440
    );
    assert.equal(
      (await readManagerReleaseAge(probe, detection("yarn")))?.minimumMinutes,
      4320
    );
  });

  it("accepts the .yml spelling of pnpm-workspace", async () => {
    const probe = probeOf({ "/r/pnpm-workspace.yml": "minimumReleaseAge: 60" });
    assert.equal(
      (await readManagerReleaseAge(probe, detection("pnpm")))?.minimumMinutes,
      60
    );
  });

  it("returns nothing when the file is missing or has no policy", async () => {
    assert.equal(
      await readManagerReleaseAge(probeOf({}), detection("pnpm")),
      undefined
    );
    assert.equal(
      await readManagerReleaseAge(
        probeOf({ "/r/pnpm-workspace.yaml": "packages: []" }),
        detection("pnpm")
      ),
      undefined
    );
    assert.equal(
      await readManagerReleaseAge(
        probeOf({ "/r/.yarnrc.yml": "nodeLinker: pnp" }),
        detection("yarn")
      ),
      undefined
    );
  });
});
