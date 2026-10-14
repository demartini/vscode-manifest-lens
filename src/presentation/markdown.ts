const SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~&]/gu;

/** Escapes text that comes from remote services before embedding it in Markdown. */
export const escapeMarkdown = (text: string): string =>
  text.replaceAll(SPECIAL, "\\$&");

/** Collapses whitespace and bounds the length of untrusted text. */
export function clip(text: string, max: number): string {
  const single = text.replaceAll(/\s+/gu, " ").trim();
  return single.length > max
    ? `${single.slice(0, Math.max(0, max - 1))}…`
    : single;
}

/** Percent-encodes a value for use inside a `command:` URI argument list. */
export const commandLink = (
  label: string,
  command: string,
  args: readonly string[]
): string =>
  `[${escapeMarkdown(label)}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;

export const safeLink = (label: string, url: string): string =>
  /^https?:\/\/\S+$/iu.test(url)
    ? `[${escapeMarkdown(label)}](${url.replaceAll(")", "%29")})`
    : escapeMarkdown(label);
