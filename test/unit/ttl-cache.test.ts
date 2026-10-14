import * as assert from "node:assert/strict";

import { TtlCache } from "../../src/infrastructure/cache/ttl-cache";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

describe("TtlCache", () => {
  it("expires entries", () => {
    let now = 0;
    const cache = new TtlCache<string>(10, () => now);
    cache.set("a", "1", 100);
    assert.equal(cache.get("a"), "1");
    now = 100;
    assert.equal(cache.get("a"), undefined);
  });

  it("evicts the least recently used entry beyond capacity", () => {
    const cache = new TtlCache<number>(2);
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.get("a");
    cache.set("c", 3, 1000);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.size, 2);
  });

  it("deduplicates concurrent loads", async () => {
    const cache = new TtlCache<string>(10);
    let calls = 0;
    const gate = deferred<string>();
    const loader = async () => {
      calls += 1;
      return await gate.promise;
    };
    const first = cache.load("k", loader, { ttlMs: 1000 });
    const second = cache.load("k", loader, { ttlMs: 1000 });
    gate.resolve("value");
    assert.deepEqual(await Promise.all([first, second]), ["value", "value"]);
    assert.equal(calls, 1);
    assert.equal(await cache.load("k", loader, { ttlMs: 1000 }), "value");
    assert.equal(calls, 1);
  });

  it("remembers failures briefly and then retries", async () => {
    let now = 0;
    const cache = new TtlCache<string>(10, () => now);
    let calls = 0;
    const loader = async () => {
      calls += 1;
      throw new Error("boom");
    };
    const options = { negativeTtlMs: 60, ttlMs: 1000 };
    await assert.rejects(cache.load("k", loader, options), /boom/u);
    await assert.rejects(cache.load("k", loader, options), /boom/u);
    assert.equal(calls, 1);
    now = 61;
    await assert.rejects(cache.load("k", loader, options), /boom/u);
    assert.equal(calls, 2);
  });

  it("aborts a shared load only when every caller has aborted", async () => {
    const cache = new TtlCache<string>(10);
    let loaderSignal: AbortSignal | undefined;
    const gate = deferred<string>();
    const loader = async (signal: AbortSignal) => {
      loaderSignal = signal;
      return await gate.promise;
    };
    const a = new AbortController();
    const b = new AbortController();
    const first = cache.load("k", loader, { signal: a.signal, ttlMs: 1000 });
    const second = cache.load("k", loader, { signal: b.signal, ttlMs: 1000 });
    a.abort();
    await assert.rejects(first, /cancelled/u);
    assert.equal(loaderSignal?.aborted, false);
    b.abort();
    await assert.rejects(second);
    assert.equal(loaderSignal?.aborted, true);
  });

  it("does not repopulate after clear()", async () => {
    const cache = new TtlCache<string>(10);
    const gate = deferred<string>();
    const pending = cache.load("k", async () => await gate.promise, {
      ttlMs: 1000,
    });
    cache.clear();
    gate.resolve("stale");
    await pending;
    assert.equal(cache.get("k"), undefined);
  });

  it("releases the in-flight slot after a cancelled load so later loads can retry", async () => {
    const cache = new TtlCache<string>(10);
    const first = new AbortController();
    let calls = 0;
    const loader = async (signal: AbortSignal) => {
      calls += 1;
      return await new Promise<string>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        if (calls > 1) {
          resolve("second");
        }
      });
    };
    const pending = cache.load("k", loader, {
      signal: first.signal,
      ttlMs: 1000,
    });
    first.abort();
    await assert.rejects(pending);
    assert.equal(await cache.load("k", loader, { ttlMs: 1000 }), "second");
    assert.equal(calls, 2);
  });
});
