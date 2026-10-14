import {
  ManifestLensError,
  isCancellation,
  normalizeError,
} from "../../shared/errors";

type Entry<V> =
  | { readonly kind: "value"; readonly expiresAt: number; readonly value: V }
  | {
      readonly kind: "error";
      readonly expiresAt: number;
      readonly error: ManifestLensError;
    };

interface InFlight<V> {
  readonly promise: Promise<V>;
  readonly controller: AbortController;
  waiters: number;
}

export interface LoadOptions {
  readonly ttlMs: number;
  /** How long a failure is remembered so it is not retried immediately. */
  readonly negativeTtlMs?: number;
  readonly signal?: AbortSignal;
}

const noop = (): undefined => undefined;

const cancelled = (): ManifestLensError =>
  new ManifestLensError("cancelled", "The operation was cancelled.");

/**
 * A bounded LRU cache with per-entry expiry that also de-duplicates concurrent
 * loads. A shared load is only aborted once every waiting caller has aborted.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inFlight = new Map<string, InFlight<V>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private generation = 0;

  constructor(maxEntries: number, now: () => number = Date.now) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.live(key);
    return entry?.kind === "value" ? entry.value : undefined;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.store(key, { expiresAt: this.now() + ttlMs, kind: "value", value });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.entries.keys()) {
      if (predicate(key)) {
        this.entries.delete(key);
      }
    }
  }

  /** Drops every entry and detaches in-flight loads so they cannot repopulate it. */
  clear(): void {
    this.entries.clear();
    this.generation += 1;
  }

  async load(
    key: string,
    loader: (signal: AbortSignal) => Promise<V>,
    options: LoadOptions
  ): Promise<V> {
    const cached = this.live(key);
    if (cached) {
      return cached.kind === "error"
        ? await Promise.reject(cached.error)
        : await Promise.resolve(cached.value);
    }
    let flight = this.inFlight.get(key);
    if (!flight) {
      flight = this.start(key, loader, options);
      this.inFlight.set(key, flight);
    }
    return await this.wait(flight, options.signal);
  }

  private live(key: string): Entry<V> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  private store(key: string, entry: Entry<V>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  private start(
    key: string,
    loader: (signal: AbortSignal) => Promise<V>,
    options: LoadOptions
  ): InFlight<V> {
    const controller = new AbortController();
    const { generation } = this;
    // The in-flight slot is released on every outcome (value, failure, cancellation).
    const release = (): void => {
      if (this.inFlight.get(key)?.controller === controller) {
        this.inFlight.delete(key);
      }
    };
    const promise = loader(controller.signal).then(
      (value) => {
        release();
        this.remember(key, generation, {
          expiresAt: this.now() + options.ttlMs,
          kind: "value",
          value,
        });
        return value;
      },
      (error: unknown) => {
        release();
        const normalized = normalizeError(error);
        if (!isCancellation(normalized) && (options.negativeTtlMs ?? 0) > 0) {
          this.remember(key, generation, {
            error: normalized,
            expiresAt: this.now() + (options.negativeTtlMs ?? 0),
            kind: "error",
          });
        }
        throw normalized;
      }
    );
    // Observe rejections so an unwatched load cannot raise an unhandled rejection.
    promise.catch(noop);
    return { controller, promise, waiters: 0 };
  }

  private remember(key: string, generation: number, entry: Entry<V>): void {
    if (generation === this.generation) {
      this.store(key, entry);
    }
  }

  private async wait(
    flight: InFlight<V>,
    signal: AbortSignal | undefined
  ): Promise<V> {
    flight.waiters += 1;
    if (!signal) {
      return await flight.promise.finally(() => {
        flight.waiters -= 1;
      });
    }
    return await new Promise<V>((resolve, reject) => {
      let waiting = true;
      const leave = (): void => {
        if (waiting) {
          waiting = false;
          flight.waiters -= 1;
          signal.removeEventListener("abort", onAbort);
        }
      };
      function onAbort(): void {
        const abandoned = waiting;
        leave();
        if (abandoned && flight.waiters === 0) {
          flight.controller.abort();
        }
        reject(cancelled());
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (value) => {
          if (waiting) {
            leave();
            resolve(value);
          }
        },
        (error: unknown) => {
          if (waiting) {
            leave();
            reject(normalizeError(error));
          }
        }
      );
    });
  }
}
