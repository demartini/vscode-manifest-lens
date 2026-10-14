const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/(authorization:\s*)(bearer|basic)\s+\S+/giu, "$1$2 ***"],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/gu, "$1***@"],
  [
    /(_authToken|_auth|_password|token|password|secret|api[_-]?key)(["']?\s*[=:]\s*["']?)[^\s"',;]+/giu,
    "$1$2***",
  ],
  [
    /\b(npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{15,})\b/gu,
    "***",
  ],
];

/** Masks credentials that could appear in log lines, URLs or process output. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replaceAll(pattern, replacement);
  }
  return result;
}
