import { ManifestLensError } from "../../shared/errors";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validates a service URL. HTTPS is required; plain HTTP is accepted only for
 * loopback hosts (local registries and tests). Embedded credentials are rejected
 * so secrets can never end up in logs or cache keys.
 */
export function validateServiceUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new ManifestLensError(
      "unsupported",
      `"${input}" is not a valid URL.`,
      { cause: error }
    );
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ManifestLensError(
      "unsupported",
      `Only https:// URLs are supported (got ${url.protocol}//).`
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ManifestLensError(
      "unsupported",
      "URLs must not embed credentials."
    );
  }
  return url;
}

/** Returns a URL safe to display or log (no credentials, query or fragment). */
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

export const joinUrl = (base: URL, path: string): string => {
  const prefix = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  return `${base.origin}${prefix}${path.replace(/^\/+/u, "")}`;
};
