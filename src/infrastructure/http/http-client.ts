import { ManifestLensError, normalizeError } from "../../shared/errors";
import { sleep } from "../../shared/utilities/concurrency";
import { validateServiceUrl, redactUrl } from "./url";

export interface HttpClientOptions {
  /** A getter lets the timeout follow live configuration changes. */
  readonly timeoutMs: number | (() => number);
  readonly maxResponseBytes: number;
  readonly retries: number;
  readonly userAgent: string;
  readonly fetchImpl?: typeof fetch;
  readonly backoffMs?: number;
}

export interface HttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const readLimited = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new ManifestLensError(
      "too-large",
      "The response is larger than the allowed limit."
    );
  }
  if (!response.body) {
    return "";
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new ManifestLensError(
        "invalid-response",
        "Unexpected response body."
      );
    }
    const bytes = chunk;
    received += bytes.byteLength;
    if (received > maxBytes) {
      throw new ManifestLensError(
        "too-large",
        "The response is larger than the allowed limit."
      );
    }
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

const statusError = (status: number, url: string): ManifestLensError => {
  const where = redactUrl(url);
  if (status === 404) {
    return new ManifestLensError("not-found", `Not found: ${where}`);
  }
  if (status === 429) {
    return new ManifestLensError("rate-limited", `Rate limited by ${where}`, {
      retryable: true,
    });
  }
  return new ManifestLensError(
    "network",
    `Request to ${where} failed with HTTP ${status}.`,
    {
      retryable: RETRYABLE_STATUS.has(status),
    }
  );
};

/**
 * A minimal JSON-over-HTTP client with timeouts, bounded retries and a response
 * size cap. It never attaches credentials to requests.
 */
export class HttpClient {
  private readonly options: HttpClientOptions;

  constructor(options: HttpClientOptions) {
    this.options = options;
  }

  async json(request: HttpRequest): Promise<unknown> {
    validateServiceUrl(request.url);
    let lastError: ManifestLensError | undefined;
    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      try {
        return await this.once(request);
      } catch (error) {
        lastError = normalizeError(error);
        if (!lastError.retryable || attempt === this.options.retries) {
          throw lastError;
        }
        await sleep(
          (this.options.backoffMs ?? 300) * 2 ** attempt,
          request.signal
        );
      }
    }
    throw lastError ?? new ManifestLensError("unexpected", "Request failed.");
  }

  private async once(request: HttpRequest): Promise<unknown> {
    const timeout = AbortSignal.timeout(
      typeof this.options.timeoutMs === "function"
        ? this.options.timeoutMs()
        : this.options.timeoutMs
    );
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        credentials: "omit",
        headers: {
          accept: "application/json",
          "user-agent": this.options.userAgent,
          ...(request.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...request.headers,
        },
        method: request.method ?? "GET",
        redirect: "follow",
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw new ManifestLensError(
          "cancelled",
          "The operation was cancelled.",
          { cause: error }
        );
      }
      if (timeout.aborted) {
        throw new ManifestLensError(
          "timeout",
          `Request to ${redactUrl(request.url)} timed out.`,
          {
            cause: error,
            retryable: true,
          }
        );
      }
      throw new ManifestLensError(
        "network",
        `Could not reach ${redactUrl(request.url)}.`,
        {
          cause: error,
          retryable: true,
        }
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw statusError(response.status, request.url);
    }
    const text = await readLimited(response, this.options.maxResponseBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ManifestLensError(
        "invalid-response",
        "The server returned invalid JSON.",
        {
          cause: error,
        }
      );
    }
  }
}
