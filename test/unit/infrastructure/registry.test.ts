import * as assert from "node:assert/strict";

import { HttpClient } from "../../../src/infrastructure/http/http-client";
import {
  NpmRegistryClient,
  normalizeRepositoryUrl,
  parsePackument,
} from "../../../src/infrastructure/registry/npm-registry-client";
import { type TestServer, sendJson, startServer } from "./test-server";

const packument = {
  description: "A package",
  "dist-tags": { latest: "2.0.0" },
  homepage: "https://example.com",
  name: "@scope/pkg",
  repository: { type: "git", url: "git+https://github.com/scope/pkg.git" },
  time: {
    "1.0.0": "2025-01-01T00:00:00.000Z",
    "2.0.0": "2025-06-01T00:00:00.000Z",
  },
  versions: {
    "1.0.0": { deprecated: "old", name: "@scope/pkg", version: "1.0.0" },
    "2.0.0": {
      peerDependencies: { react: "^19.0.0", sass: "^1.0.0" },
      peerDependenciesMeta: { sass: { optional: true } },
      version: "2.0.0",
    },
    "3.0.0": { peerDependencies: { broken: 42 } },
  },
};

describe("parsePackument", () => {
  it("reduces the document and extracts peers, deprecation and dates", () => {
    const metadata = parsePackument(packument, 123);
    assert.equal(metadata.repositoryUrl, "https://github.com/scope/pkg");
    assert.equal(metadata.distTags.latest, "2.0.0");
    assert.equal(metadata.versions["1.0.0"]?.deprecated, "old");
    assert.equal(
      metadata.versions["2.0.0"]?.publishedAt,
      "2025-06-01T00:00:00.000Z"
    );
    assert.deepEqual(metadata.versions["2.0.0"]?.optionalPeers, ["sass"]);
    assert.equal(metadata.versions["2.0.0"]?.peerDependencies.react, "^19.0.0");
    assert.equal(
      metadata.versions["3.0.0"],
      undefined,
      "malformed versions are dropped, not trusted"
    );
    assert.equal(metadata.fetchedAt, 123);
  });

  it("reads the license and the Node engine range of each version", () => {
    const metadata = parsePackument(
      {
        name: "a",
        versions: {
          "1.0.0": { engines: { node: ">=18" }, license: "MIT" },
          "2.0.0": { license: { type: "Apache-2.0", url: "https://x.test" } },
          "3.0.0": {},
        },
      },
      0
    );
    assert.equal(metadata.versions["1.0.0"]?.license, "MIT");
    assert.equal(metadata.versions["1.0.0"]?.nodeEngine, ">=18");
    assert.equal(metadata.versions["2.0.0"]?.license, "Apache-2.0");
    assert.equal(metadata.versions["3.0.0"]?.license, undefined);
    assert.equal(metadata.versions["3.0.0"]?.nodeEngine, undefined);
  });

  it("keeps a version whose license or engines are malformed", () => {
    const metadata = parsePackument(
      {
        name: "a",
        versions: {
          "1.0.0": { engines: ["node"], license: 42 },
          "2.0.0": { engines: { node: 18 }, license: "  " },
          "3.0.0": { license: { type: 7 } },
        },
      },
      0
    );
    for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
      assert.ok(metadata.versions[version], `${version} is kept`);
      assert.equal(metadata.versions[version]?.license, undefined);
      assert.equal(metadata.versions[version]?.nodeEngine, undefined);
    }
  });

  it("rejects unexpected shapes", () => {
    assert.throws(() => parsePackument({ versions: 3 }, 0), {
      code: "invalid-response",
    });
    assert.throws(() => parsePackument("nope", 0), {
      code: "invalid-response",
    });
  });

  it("drops non-http homepages", () => {
    const metadata = parsePackument(
      { homepage: "javascript:alert(1)", name: "a", versions: {} },
      0
    );
    assert.equal(metadata.homepage, undefined);
  });
});

describe("normalizeRepositoryUrl", () => {
  const cases: [string | undefined, string | undefined][] = [
    ["git+https://github.com/a/b.git", "https://github.com/a/b"],
    ["git://github.com/a/b.git", "https://github.com/a/b"],
    ["git@github.com:a/b.git", "https://github.com/a/b"],
    ["github:a/b", "https://github.com/a/b"],
    ["a/b", "https://github.com/a/b"],
    ["ssh://git@gitlab.com/a/b.git", "https://gitlab.com/a/b"],
    ["javascript:alert(1)", undefined],
    [undefined, undefined],
  ];
  for (const [input, expected] of cases) {
    it(`${String(input)} -> ${String(expected)}`, () => {
      assert.equal(normalizeRepositoryUrl(input), expected);
    });
  }
});

describe("NpmRegistryClient", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const make = (url: string, now = () => Date.now()) =>
    new NpmRegistryClient({
      http: new HttpClient({
        backoffMs: 1,
        maxResponseBytes: 1_000_000,
        retries: 0,
        timeoutMs: 1000,
        userAgent: "test",
      }),
      now,
      settings: () => ({ cacheTtlMs: 60_000, registryUrl: url }),
    });

  it("requests scoped names with an encoded slash and caches the result", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, packument);
    });
    const client = make(server.url);
    const first = await client.getPackage("@scope/pkg");
    const second = await client.getPackage("@scope/pkg");
    assert.ok(first.ok && second.ok);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.url, "/@scope%2Fpkg");
  });

  it("deduplicates concurrent requests", async () => {
    server = await startServer((_req, res) =>
      setTimeout(() => {
        sendJson(res, packument);
      }, 30)
    );
    const client = make(server.url);
    await Promise.all([
      client.getPackage("@scope/pkg"),
      client.getPackage("@scope/pkg"),
    ]);
    assert.equal(server.requests.length, 1);
  });

  it("returns errors as values and briefly remembers failures", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, {}, 404);
    });
    const client = make(server.url);
    const result = await client.getPackage("missing");
    assert.equal(!result.ok && result.error.code, "not-found");
    await client.getPackage("missing");
    assert.equal(server.requests.length, 1);
    client.clearCache();
    await client.getPackage("missing");
    assert.equal(server.requests.length, 2);
  });

  it("rejects invalid names and unsafe registry URLs without network access", async () => {
    const client = make("https://registry.npmjs.org/");
    const bad = await client.getPackage("../etc/passwd");
    assert.equal(!bad.ok && bad.error.code, "unsupported");
    const unsafe = await make("http://evil.example.com/").getPackage("react");
    assert.equal(!unsafe.ok && unsafe.error.code, "unsupported");
  });

  it("reports malformed registry payloads as invalid-response", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, [1, 2, 3]);
    });
    const result = await make(server.url).getPackage("react");
    assert.equal(!result.ok && result.error.code, "invalid-response");
  });
});
