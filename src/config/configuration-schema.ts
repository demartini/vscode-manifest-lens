import { z } from "zod";

/** Every value falls back to its default when the user's setting is invalid. */
const bool = (fallback: boolean) => z.boolean().catch(fallback);
const bounded = (fallback: number, min: number, max: number) =>
  z.number().min(min).max(max).catch(fallback);

export const configurationSchema = z.object({
  analysis: z.object({
    concurrency: bounded(4, 1, 16),
    timeout: bounded(10_000, 1000, 120_000),
  }),
  annotations: z.object({
    minimumUpdateSeverity: z.enum(["patch", "minor", "major"]).catch("patch"),
  }),
  cacheTimeout: bounded(300_000, 0, 24 * 60 * 60 * 1000),
  codeLens: z.object({
    enabled: bool(true),
    showOnStartup: bool(true),
    showUpToDate: bool(false),
  }),
  logging: z.object({
    level: z.enum(["off", "error", "warn", "info", "debug"]).catch("warn"),
  }),
  /** Minutes a version must have been published before it is suggested; 0 disables it. */
  minimumReleaseAge: bounded(0, 0, 525_600),
  packageManager: z.enum(["auto", "npm", "pnpm", "yarn", "bun"]).catch("auto"),
  peerDependencies: z.object({ enabled: bool(true) }),
  prerelease: z.object({
    enabled: bool(false),
    tags: z.array(z.string().min(1).max(40)).max(20).catch([]),
  }),
  registry: z.string().catch("https://registry.npmjs.org/"),
  security: z.object({
    enabled: bool(true),
    warnBeforeAdvisoryUpgrade: bool(true),
  }),
  showLatestVersionHint: bool(true),
  showVersionStatus: bool(true),
  updatePolicy: z.enum(["conservative", "force"]).catch("conservative"),
  workspace: z.object({ enabled: bool(true) }),
});

export type ManifestLensConfig = z.infer<typeof configurationSchema>;

export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/**
 * Parses raw `workspace.getConfiguration("manifestLens")` data. Unknown or
 * invalid values never throw; they fall back to documented defaults.
 */
export function parseConfiguration(
  raw: Record<string, unknown>
): ManifestLensConfig {
  const section = (name: string): Record<string, unknown> => {
    const value = raw[name];
    return typeof value === "object" && value !== null ? { ...value } : {};
  };
  return configurationSchema.parse({
    analysis: section("analysis"),
    annotations: section("annotations"),
    cacheTimeout: raw.cacheTimeout,
    codeLens: section("codeLens"),
    logging: section("logging"),
    minimumReleaseAge: raw.minimumReleaseAge,
    packageManager: raw.packageManager,
    peerDependencies: section("peerDependencies"),
    prerelease: section("prerelease"),
    registry: raw.registry,
    security: section("security"),
    showLatestVersionHint: raw.showLatestVersionHint,
    showVersionStatus: raw.showVersionStatus,
    updatePolicy: raw.updatePolicy,
    workspace: section("workspace"),
  });
}
