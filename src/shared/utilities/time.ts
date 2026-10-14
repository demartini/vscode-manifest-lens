const UNITS: readonly (readonly [string, number])[] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/** Formats an ISO timestamp as a short relative age such as "4 days ago". */
export function formatRelativeTime(
  iso: string | undefined,
  now: number
): string | undefined {
  if (iso === undefined) {
    return undefined;
  }
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return undefined;
  }
  const elapsed = Math.max(0, now - time);
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) {
      const count = Math.floor(elapsed / size);
      return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

export const formatCount = (value: number): string =>
  new Intl.NumberFormat("en", {
    compactDisplay: "short",
    notation: "compact",
  }).format(value);
