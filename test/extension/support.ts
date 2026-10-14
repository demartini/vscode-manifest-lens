import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import * as vscode from "vscode";

import type { ManifestLensTestApi } from "../../src/extension";

export const EXTENSION_ID = "demartini.manifest-lens";

export const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await sleep(50);
  }
}

export async function getApi(): Promise<ManifestLensTestApi> {
  const extension =
    vscode.extensions.getExtension<ManifestLensTestApi>(EXTENSION_ID);
  if (!extension) {
    throw new Error(`Extension ${EXTENSION_ID} was not found`);
  }
  return extension.isActive ? extension.exports : await extension.activate();
}

export interface Packument {
  readonly versions: Record<
    string,
    {
      peerDependencies?: Record<string, string>;
      deprecated?: string;
      license?: string;
      engines?: { node: string };
    }
  >;
  readonly latest?: string;
}

export const DEFAULT_PUBLISHED_AT = "2025-12-01T00:00:00.000Z";

export interface FakeServer {
  readonly url: string;
  readonly requests: string[];
  delayMs: number;
  /** Publication date reported for every version of every package. */
  publishedAt: string;
  failing: Set<string>;
  close(): Promise<void>;
}

const listen = async (
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
    server: FakeServer
  ) => void
): Promise<FakeServer> => {
  const fake: FakeServer = {
    close: async () =>
      await new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
    delayMs: 0,
    failing: new Set(),
    publishedAt: DEFAULT_PUBLISHED_AT,
    requests: [],
    url: "",
  };
  const http: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
    });
    request.on("end", () => {
      fake.requests.push(request.url ?? "");
      setTimeout(() => handler(request, response, body, fake), fake.delayMs);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as AddressInfo;
  return Object.assign(fake, { url: `http://127.0.0.1:${address.port}/` });
};

const json = (response: ServerResponse, value: unknown, status = 200): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

/** A local npm-compatible registry serving the given packuments. */
export const startRegistry = async (
  packages: Record<string, Packument>
): Promise<FakeServer> =>
  await listen((request, response, _body, server) => {
    const name = decodeURIComponent((request.url ?? "").slice(1));
    if (server.failing.has(name)) {
      json(response, {}, 500);
      return;
    }
    const found = packages[name];
    if (!found) {
      json(response, { error: "not found" }, 404);
      return;
    }
    const versions = Object.keys(found.versions);
    json(response, {
      description: `${name} test package`,
      "dist-tags": { latest: found.latest ?? versions.at(-1) },
      name,
      time: Object.fromEntries(
        versions.map((version) => [version, server.publishedAt])
      ),
      versions: Object.fromEntries(
        versions.map((version) => [
          version,
          { name, version, ...found.versions[version] },
        ])
      ),
    });
  });

export interface FakeVulnerability {
  readonly id: string;
  readonly package: string;
  readonly introduced: string;
  readonly fixed?: string;
}

/** A local OSV API serving the given vulnerabilities. */
export const startOsv = async (
  vulnerabilities: FakeVulnerability[]
): Promise<FakeServer> =>
  await listen((request, response, body) => {
    if (request.url === "/v1/querybatch") {
      const { queries } = JSON.parse(body) as {
        queries: { package: { name: string }; version: string }[];
      };
      json(response, {
        results: queries.map((query) => ({
          vulns: vulnerabilities
            .filter((vuln) => vuln.package === query.package.name)
            .filter(
              (vuln) =>
                compare(query.version, vuln.introduced) >= 0 &&
                (vuln.fixed === undefined ||
                  compare(query.version, vuln.fixed) < 0)
            )
            .map((vuln) => ({ id: vuln.id })),
        })),
      });
      return;
    }
    const id = decodeURIComponent(
      (request.url ?? "").replace("/v1/vulns/", "")
    );
    const vuln = vulnerabilities.find((candidate) => candidate.id === id);
    if (!vuln) {
      json(response, {}, 404);
      return;
    }
    json(response, {
      affected: [
        {
          package: { ecosystem: "npm", name: vuln.package },
          ranges: [
            {
              events: [
                { introduced: vuln.introduced },
                ...(vuln.fixed ? [{ fixed: vuln.fixed }] : []),
              ],
              type: "SEMVER",
            },
          ],
        },
      ],
      database_specific: { severity: "HIGH" },
      id,
      references: [{ type: "ADVISORY", url: `https://example.com/${id}` }],
      summary: `${id} test advisory`,
    });
  });

const compare = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
};

export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("The test workspace folder is not open");
  }
  return folder.uri.fsPath;
}

export interface TestCase {
  readonly dir: string;
  uri(relative?: string): vscode.Uri;
  write(relative: string, content: string | object): Promise<void>;
  install(
    name: string,
    version: string,
    peers?: Record<string, string>
  ): Promise<void>;
  cleanup(): Promise<void>;
}

/** Creates an isolated directory inside the fixture workspace for one test. */
export async function createCase(name: string): Promise<TestCase> {
  const dir = join(workspaceRoot(), "cases", `${name}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const write = async (
    relative: string,
    content: string | object
  ): Promise<void> => {
    const path = join(dir, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      typeof content === "string"
        ? content
        : `${JSON.stringify(content, null, 2)}\n`
    );
  };
  return {
    cleanup: async () =>
      // Windows keeps the directory locked for a moment after the editors close.
      await rm(dir, {
        force: true,
        maxRetries: 10,
        recursive: true,
        retryDelay: 100,
      }),
    dir,
    install: async (packageName, version, peers) =>
      await write(join("node_modules", packageName, "package.json"), {
        name: packageName,
        ...(peers ? { peerDependencies: peers } : {}),
        version,
      }),
    uri: (relative = "package.json") => vscode.Uri.file(join(dir, relative)),
    write,
  };
}

/**
 * Puts a fake package manager first on PATH. It records its invocation instead
 * of touching the network, so install flows are testable and hermetic.
 */
export async function installFakePackageManager(
  directory: string,
  markerFile: string
): Promise<() => void> {
  await mkdir(directory, { recursive: true });
  const original = process.env.PATH;
  for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
    if (process.platform === "win32") {
      await writeFile(
        join(directory, `${manager}.cmd`),
        `@echo off\r\necho %cd% ${manager} %* >> "${markerFile}"\r\n`
      );
    } else {
      const script = join(directory, manager);
      await writeFile(
        script,
        `#!/bin/sh\necho "$(pwd) ${manager} $@" >> "${markerFile}"\n`
      );
      await chmod(script, 0o755);
    }
  }
  process.env.PATH = `${directory}${process.platform === "win32" ? ";" : ":"}${original ?? ""}`;
  return () => {
    process.env.PATH = original;
  };
}

export async function setConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("manifestLens")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

export async function resetConfig(keys: string[]): Promise<void> {
  for (const key of keys) {
    await setConfig(key, undefined);
  }
}

export async function openText(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  return document;
}

export async function waitForAnalysis(
  api: ManifestLensTestApi,
  uri: vscode.Uri,
  predicate: (
    state: NonNullable<ReturnType<ManifestLensTestApi["analysis"]["get"]>>
  ) => boolean = (state) => state.status === "ready" && !state.stale
): Promise<NonNullable<ReturnType<ManifestLensTestApi["analysis"]["get"]>>> {
  try {
    return await waitFor(() => {
      const state = api.analysis.get(uri.toString());
      return state && predicate(state) ? state : undefined;
    }, `analysis of ${uri.fsPath}`);
  } catch (error) {
    const state = api.analysis.get(uri.toString());
    throw new Error(
      `${String(error)} — state: ${JSON.stringify({
        busy: api.analysis.isBusy,
        error: state?.error?.message,
        stale: state?.stale,
        status: state?.status,
      })}`,
      { cause: error }
    );
  }
}

export const lensTitles = async (uri: vscode.Uri): Promise<string[]> => {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    "vscode.executeCodeLensProvider",
    uri
  );
  return lenses
    .map((lens) => lens.command?.title ?? "")
    .filter((title) => title !== "");
};
