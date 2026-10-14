import { ManifestLensError } from "../errors";

const cancelled = (): ManifestLensError =>
  new ManifestLensError("cancelled", "The operation was cancelled.");

export const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw cancelled();
  }
};

/** Maps `items` with at most `limit` concurrent calls, preserving result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      throwIfAborted(signal);
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await fn(item, index);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );
  return results;
}

/** Resolves after `ms`, or rejects with a cancellation error when aborted. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(cancelled());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
