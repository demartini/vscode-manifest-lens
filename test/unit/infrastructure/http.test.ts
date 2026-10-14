import * as assert from "node:assert/strict";

import { HttpClient } from "../../../src/infrastructure/http/http-client";
import {
  redactUrl,
  validateServiceUrl,
} from "../../../src/infrastructure/http/url";
import { type TestServer, sendJson, startServer } from "./test-server";

const client = (
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}
) =>
  new HttpClient({
    backoffMs: 1,
    maxResponseBytes: 1024,
    retries: 2,
    timeoutMs: 1000,
    userAgent: "test",
    ...overrides,
  });

describe("validateServiceUrl", () => {
  it("accepts https and loopback http only", () => {
    assert.ok(validateServiceUrl("https://registry.npmjs.org/"));
    assert.ok(validateServiceUrl("http://127.0.0.1:4873/"));
    assert.ok(validateServiceUrl("http://localhost:4873/"));
    assert.throws(
      () => validateServiceUrl("http://registry.example.com/"),
      /https/u
    );
    assert.throws(
      () => validateServiceUrl("ftp://registry.example.com/"),
      /https/u
    );
    assert.throws(() => validateServiceUrl("file:///etc/passwd"), /https/u);
    assert.throws(() => validateServiceUrl("not a url"), /valid URL/u);
  });

  it("rejects embedded credentials and redacts for logging", () => {
    assert.throws(
      () => validateServiceUrl("https://user:secret@registry.example.com/"),
      /credentials/u
    );
    assert.equal(
      redactUrl("https://u:p@example.com/a/b?token=1#x"),
      "https://example.com/a/b"
    );
  });
});

describe("HttpClient", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns parsed JSON and never sends credentials or cookies", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, { ok: true });
    });
    assert.deepEqual(await client().json({ url: server.url }), { ok: true });
    assert.equal(server.requests[0]?.headers.authorization, undefined);
    assert.equal(server.requests[0]?.headers["user-agent"], "test");
  });

  it("maps 404 to not-found without retrying", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, {}, 404);
    });
    await assert.rejects(client().json({ url: server.url }), {
      code: "not-found",
    });
    assert.equal(server.requests.length, 1);
  });

  it("retries transient failures and then succeeds", async () => {
    let calls = 0;
    server = await startServer((_req, res) => {
      calls += 1;
      if (calls < 3) {
        sendJson(res, {}, 503);
      } else {
        sendJson(res, { done: calls });
      }
    });
    assert.deepEqual(await client().json({ url: server.url }), { done: 3 });
  });

  it("gives up after the retry budget", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, {}, 500);
    });
    await assert.rejects(client({ retries: 1 }).json({ url: server.url }), {
      code: "network",
    });
    assert.equal(server.requests.length, 2);
  });

  it("enforces the response size limit", async () => {
    server = await startServer((_req, res) => {
      sendJson(res, { big: "x".repeat(5000) });
    });
    await assert.rejects(client().json({ url: server.url }), {
      code: "too-large",
    });
  });

  it("rejects invalid JSON", async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("<html>");
    });
    await assert.rejects(client().json({ url: server.url }), {
      code: "invalid-response",
    });
  });

  it("times out", async () => {
    server = await startServer(() => {});
    await assert.rejects(
      client({ retries: 0, timeoutMs: 50 }).json({ url: server.url }),
      {
        code: "timeout",
      }
    );
  });

  it("honours caller cancellation", async () => {
    server = await startServer(() => {});
    const controller = new AbortController();
    const pending = client().json({
      signal: controller.signal,
      url: server.url,
    });
    setTimeout(() => {
      controller.abort();
    }, 20);
    await assert.rejects(pending, { code: "cancelled" });
  });

  it("refuses non-https remote URLs before any network call", async () => {
    await assert.rejects(client().json({ url: "http://example.com/" }), {
      code: "unsupported",
    });
  });
});
