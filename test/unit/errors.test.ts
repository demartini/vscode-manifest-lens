import * as assert from "node:assert/strict";

import { ManifestLensError, normalizeError } from "../../src/shared/errors";

describe("normalizeError", () => {
  it("keeps ManifestLensError instances", () => {
    const original = new ManifestLensError("network", "boom");
    assert.equal(normalizeError(original), original);
  });

  it("maps abort and timeout errors to dedicated codes", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timeout = new Error("slow");
    timeout.name = "TimeoutError";
    assert.equal(normalizeError(abort).code, "cancelled");
    assert.equal(normalizeError(timeout).code, "timeout");
    assert.equal(normalizeError(timeout).retryable, true);
  });

  it("wraps unknown values", () => {
    assert.equal(normalizeError("text").message, "text");
    assert.equal(normalizeError(new Error("x")).code, "unexpected");
  });
});
