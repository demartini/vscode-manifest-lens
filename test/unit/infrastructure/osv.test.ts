import * as assert from "node:assert/strict";

import { HttpClient } from "../../../src/infrastructure/http/http-client";
import {
  OsvClient,
  parseVulnerability,
} from "../../../src/infrastructure/osv/osv-client";
import { type TestServer, sendJson, startServer } from "./test-server";

const vuln = (id: string, extra: Record<string, unknown> = {}) => ({
  affected: [
    {
      package: { ecosystem: "npm", name: "lodash" },
      ranges: [
        { events: [{ introduced: "0" }, { fixed: "4.17.21" }], type: "SEMVER" },
      ],
    },
  ],
  aliases: ["CVE-2021-1"],
  database_specific: { severity: "HIGH" },
  details: "Details\nmore",
  id,
  modified: "2024-01-01T00:00:00Z",
  references: [
    { type: "ADVISORY", url: "https://github.com/advisories/x" },
    { type: "WEB", url: "javascript:alert(1)" },
  ],
  summary: "Prototype pollution",
  ...extra,
});

describe("parseVulnerability", () => {
  it("normalizes events, severity and references", () => {
    const advisory = parseVulnerability(vuln("GHSA-1"));
    assert.equal(advisory.severity, "high");
    assert.deepEqual(advisory.affected[0]?.ranges[0]?.events, [
      { introduced: "0" },
      { fixed: "4.17.21" },
    ]);
    assert.equal(
      advisory.references.length,
      1,
      "non-web references are dropped"
    );
    assert.deepEqual(advisory.aliases, ["CVE-2021-1"]);
  });

  it("falls back to details for the summary and unknown severity", () => {
    const advisory = parseVulnerability({
      details: "First line\nSecond",
      id: "X-1",
    });
    assert.equal(advisory.summary, "First line");
    assert.equal(advisory.severity, "unknown");
  });

  it("rejects records without an id", () => {
    assert.throws(() => parseVulnerability({ summary: "x" }), {
      code: "invalid-response",
    });
  });
});

describe("OsvClient", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const make = (url: string) =>
    new OsvClient({
      http: new HttpClient({
        backoffMs: 1,
        maxResponseBytes: 1_000_000,
        retries: 0,
        timeoutMs: 1000,
        userAgent: "test",
      }),
      settings: () => ({ baseUrl: url, cacheTtlMs: 60_000, concurrency: 2 }),
    });

  it("associates batch results with their queries and fetches each record once", async () => {
    server = await startServer((req, res, body) => {
      if (req.url === "/v1/querybatch") {
        const { queries } = JSON.parse(body) as {
          queries: { package: { name: string }; version: string }[];
        };
        sendJson(res, {
          results: queries.map((query) =>
            query.package.name === "lodash"
              ? { vulns: [{ id: "GHSA-1" }, { id: "GHSA-2" }] }
              : {}
          ),
        });
      } else if (req.url?.startsWith("/v1/vulns/")) {
        sendJson(
          res,
          vuln(decodeURIComponent(req.url.slice("/v1/vulns/".length)))
        );
      } else {
        sendJson(res, {}, 404);
      }
    });
    const client = make(server.url);
    const result = await client.query([
      { name: "lodash", version: "4.17.0" },
      { name: "lodash", version: "4.17.1" },
      { name: "clean", version: "1.0.0" },
    ]);
    const dirty = result.get("lodash@4.17.0");
    assert.ok(dirty?.ok);
    assert.deepEqual(dirty.value.map((a) => a.id).toSorted(), [
      "GHSA-1",
      "GHSA-2",
    ]);
    const clean = result.get("clean@1.0.0");
    assert.ok(clean?.ok);
    assert.equal(clean.value.length, 0);
    const detailRequests = server.requests.filter((r) =>
      r.url.startsWith("/v1/vulns/")
    );
    assert.equal(
      detailRequests.length,
      2,
      "records are fetched once even when shared by queries"
    );
    const batch = server.requests.find((r) => r.url === "/v1/querybatch");
    assert.equal(
      JSON.parse(batch?.body ?? "{}").queries[0].package.ecosystem,
      "npm"
    );

    await client.query([{ name: "lodash", version: "4.17.0" }]);
    assert.equal(
      server.requests.filter((r) => r.url === "/v1/querybatch").length,
      1,
      "cached"
    );
  });

  it("reports a failed batch as errors, never as clean results", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, {}, 500);
    });
    const result = await make(server.url).query([
      { name: "a", version: "1.0.0" },
    ]);
    const entry = result.get("a@1.0.0");
    assert.equal(entry?.ok, false);
  });

  it("reports partial failures when a record cannot be retrieved", async () => {
    server = await startServer((req, res) => {
      if (req.url === "/v1/querybatch") {
        sendJson(res, {
          results: [
            { vulns: [{ id: "GHSA-1" }] },
            { vulns: [{ id: "GHSA-BAD" }] },
          ],
        });
      } else if (req.url === "/v1/vulns/GHSA-1") {
        sendJson(res, vuln("GHSA-1"));
      } else {
        sendJson(res, {}, 500);
      }
    });
    const result = await make(server.url).query([
      { name: "a", version: "1.0.0" },
      { name: "b", version: "1.0.0" },
    ]);
    assert.equal(result.get("a@1.0.0")?.ok, true);
    assert.equal(result.get("b@1.0.0")?.ok, false);
  });

  it("follows pagination tokens", async () => {
    server = await startServer((req, res, body) => {
      if (req.url === "/v1/querybatch") {
        const { queries } = JSON.parse(body) as {
          queries: { page_token?: string }[];
        };
        const page = queries[0]?.page_token;
        sendJson(
          res,
          page === undefined
            ? {
                results: [{ next_page_token: "t2", vulns: [{ id: "GHSA-1" }] }],
              }
            : { results: [{ vulns: [{ id: "GHSA-2" }] }] }
        );
      } else {
        sendJson(res, vuln(req.url?.split("/").pop() ?? "x"));
      }
    });
    const result = await make(server.url).query([
      { name: "a", version: "1.0.0" },
    ]);
    const entry = result.get("a@1.0.0");
    assert.ok(entry?.ok);
    assert.equal(entry.value.length, 2);
  });

  it("rejects mismatched batch sizes", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, { results: [] });
    });
    const result = await make(server.url).query([
      { name: "a", version: "1.0.0" },
    ]);
    assert.equal(result.get("a@1.0.0")?.ok, false);
  });
});
