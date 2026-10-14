import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeInstalledPackages } from "../../../src/infrastructure/installed-packages/node-installed-packages";
import {
  type FileProbe,
  detectPackageManager,
  parsePackageManagerField,
} from "../../../src/infrastructure/package-manager/detect";
import {
  Installer,
  installArguments,
} from "../../../src/infrastructure/package-manager/installer";
import { runProcess } from "../../../src/infrastructure/process/run-process";

const probeOf = (files: Record<string, string>): FileProbe => ({
  exists: async (path) => path in files,
  readText: async (path) => files[path],
});

describe("detectPackageManager", () => {
  it("finds the lockfile at the monorepo root, not at the package", async () => {
    const result = await detectPackageManager({
      boundary: "/repo",
      configured: "auto",
      manifestDir: "/repo/packages/ui",
      probe: probeOf({
        "/repo/packages/ui/package.json": "{}",
        "/repo/pnpm-lock.yaml": "",
      }),
    });
    assert.equal(result.manager, "pnpm");
    assert.equal(result.root, "/repo");
  });

  it("prefers the closest lockfile", async () => {
    const result = await detectPackageManager({
      boundary: "/repo",
      configured: "auto",
      manifestDir: "/repo/apps/web",
      probe: probeOf({
        "/repo/apps/web/yarn.lock": "",
        "/repo/package-lock.json": "",
      }),
    });
    assert.equal(result.manager, "yarn");
    assert.equal(result.root, "/repo/apps/web");
  });

  it("detects bun and honours the packageManager field when no lockfile exists", async () => {
    const bun = await detectPackageManager({
      boundary: "/r",
      configured: "auto",
      manifestDir: "/r",
      probe: probeOf({ "/r/bun.lock": "" }),
    });
    assert.equal(bun.manager, "bun");
    const field = await detectPackageManager({
      boundary: "/r",
      configured: "auto",
      manifestDir: "/r/pkg",
      probe: probeOf({ "/r/package.json": '{"packageManager":"pnpm@9.1.0"}' }),
    });
    assert.equal(field.manager, "pnpm");
    assert.equal(field.root, "/r");
  });

  it("lets configuration override the manager but keeps the lockfile root", async () => {
    const result = await detectPackageManager({
      boundary: "/r",
      configured: "bun",
      manifestDir: "/r/pkg",
      probe: probeOf({ "/r/package-lock.json": "" }),
    });
    assert.equal(result.manager, "bun");
    assert.equal(result.root, "/r");
  });

  it("falls back to npm in the manifest directory", async () => {
    const result = await detectPackageManager({
      boundary: "/r",
      configured: "auto",
      manifestDir: "/r/pkg",
      probe: probeOf({}),
    });
    assert.equal(result.manager, "npm");
    assert.equal(result.root, "/r/pkg");
  });

  it("parses the packageManager field", () => {
    assert.equal(parsePackageManagerField("yarn@4.0.0"), "yarn");
    assert.equal(parsePackageManagerField("deno@1"), undefined);
    assert.equal(parsePackageManagerField(), undefined);
  });
});

describe("Installer", () => {
  it("only allows vetted install arguments", () => {
    assert.deepEqual(installArguments("pnpm"), ["install"]);
    assert.deepEqual(installArguments("npm", "--legacy-peer-deps"), [
      "install",
      "--legacy-peer-deps",
    ]);
    assert.throws(() => installArguments("pnpm", "--legacy-peer-deps"), {
      code: "unsupported",
    });
  });

  it("refuses concurrent installs for the same root", async () => {
    const installer = new Installer();
    const controller = new AbortController();
    const first = installer.install({
      manager: "npm",
      root: tmpdir(),
      signal: controller.signal,
    });
    assert.equal(installer.isRunning(tmpdir()), true);
    await assert.rejects(
      installer.install({ manager: "npm", root: tmpdir() }),
      { code: "process" }
    );
    controller.abort();
    await first.catch(() => {});
    assert.equal(installer.isRunning(tmpdir()), false);
  });
});

describe("runProcess", () => {
  it("passes arguments verbatim (no shell interpretation) and streams output", async () => {
    const lines: string[] = [];
    const result = await runProcess({
      args: [
        "-e",
        "console.log(process.argv[1]); console.error('err')",
        "$(echo pwned);`x`",
      ],
      command: process.execPath,
      cwd: tmpdir(),
      onOutput: (line) => lines.push(line),
    });
    assert.equal(result.exitCode, 0);
    assert.ok(lines.includes("$(echo pwned);`x`"));
    assert.ok(lines.includes("err"));
  });

  it("reports non-zero exit codes", async () => {
    const result = await runProcess({
      args: ["-e", "process.exit(3)"],
      command: process.execPath,
      cwd: tmpdir(),
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.cancelled, false);
  });

  it("can be cancelled", async () => {
    const controller = new AbortController();
    const pending = runProcess({
      args: ["-e", "setInterval(() => {}, 1000)"],
      command: process.execPath,
      cwd: tmpdir(),
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await pending;
    assert.equal(result.cancelled, true);
  });

  it("surfaces spawn failures as process errors", async () => {
    await assert.rejects(
      runProcess({
        args: [],
        command: "definitely-not-a-real-binary-xyz",
        cwd: tmpdir(),
      }),
      { code: "process" }
    );
  });
});

describe("NodeInstalledPackages", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("walks up node_modules, handles scopes and reads peer metadata", async () => {
    dir = await mkdtemp(join(tmpdir(), "pl-installed-"));
    await mkdir(join(dir, "node_modules", "@scope", "pkg"), {
      recursive: true,
    });
    await mkdir(join(dir, "node_modules", "plain"), { recursive: true });
    await mkdir(join(dir, "packages", "app"), { recursive: true });
    await writeFile(
      join(dir, "node_modules", "@scope", "pkg", "package.json"),
      JSON.stringify({
        peerDependencies: { react: "^18", sass: "*" },
        peerDependenciesMeta: { sass: { optional: true } },
        version: "1.2.3",
      })
    );
    await writeFile(
      join(dir, "node_modules", "plain", "package.json"),
      "{ not json"
    );
    const installed = new NodeInstalledPackages();
    const found = await installed.lookup(
      join(dir, "packages", "app"),
      "@scope/pkg"
    );
    assert.equal(found?.version, "1.2.3");
    assert.deepEqual(found?.optionalPeers, ["sass"]);
    assert.equal(found?.peerDependencies.react, "^18");
    assert.equal(
      await installed.lookup(join(dir, "packages", "app"), "plain"),
      undefined
    );
    assert.equal(
      await installed.lookup(join(dir, "packages", "app"), "missing"),
      undefined
    );
  });
});
