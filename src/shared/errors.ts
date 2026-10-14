export type ErrorCode =
  | "cancelled"
  | "invalid-response"
  | "network"
  | "not-found"
  | "process"
  | "rate-limited"
  | "stale"
  | "timeout"
  | "too-large"
  | "unexpected"
  | "unsupported";

/** An error with a stable machine-readable code that the UI can classify. */
export class ManifestLensError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ManifestLensError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** Converts anything that was thrown into a {@link ManifestLensError}. */
export const normalizeError = (error: unknown): ManifestLensError => {
  if (error instanceof ManifestLensError) {
    return error;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new ManifestLensError(
        "cancelled",
        "The operation was cancelled.",
        {
          cause: error,
        }
      );
    }
    if (error.name === "TimeoutError") {
      return new ManifestLensError("timeout", "The request timed out.", {
        cause: error,
        retryable: true,
      });
    }
    return new ManifestLensError("unexpected", error.message, { cause: error });
  }
  return new ManifestLensError("unexpected", String(error));
};

export const isCancellation = (error: unknown): boolean =>
  normalizeError(error).code === "cancelled";
