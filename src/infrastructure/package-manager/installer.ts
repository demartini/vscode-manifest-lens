import type {
  InstallFlag,
  InstallResult,
  PackageManagerName,
} from "../../domain/package-manager/types";
import { ManifestLensError } from "../../shared/errors";
import { runProcess } from "../process/run-process";

const ALLOWED_FLAGS: Readonly<
  Record<PackageManagerName, readonly InstallFlag[]>
> = {
  bun: [],
  npm: ["--legacy-peer-deps"],
  pnpm: [],
  yarn: [],
};

export interface InstallRequest {
  readonly manager: PackageManagerName;
  readonly root: string;
  /** Explicit, user-approved flag; only a short allow-list is accepted. */
  readonly flag?: InstallFlag;
  readonly signal?: AbortSignal;
  readonly onOutput?: (line: string) => void;
}

/** Builds the argv for an install; flags outside the allow-list are rejected. */
export function installArguments(
  manager: PackageManagerName,
  flag?: InstallFlag
): string[] {
  if (flag !== undefined && !ALLOWED_FLAGS[manager].includes(flag)) {
    throw new ManifestLensError(
      "unsupported",
      `${flag} is not supported by ${manager}.`
    );
  }
  return flag === undefined ? ["install"] : ["install", flag];
}

/** Runs `<manager> install`, allowing one installation per project root at a time. */
export class Installer {
  private readonly running = new Set<string>();

  isRunning(root: string): boolean {
    return this.running.has(root);
  }

  async install(request: InstallRequest): Promise<InstallResult> {
    if (this.running.has(request.root)) {
      throw new ManifestLensError(
        "process",
        `An installation is already running in ${request.root}.`
      );
    }
    const args = installArguments(request.manager, request.flag);
    this.running.add(request.root);
    try {
      const windows = process.platform === "win32";
      const result = await runProcess({
        args,
        command: windows ? `${request.manager}.cmd` : request.manager,
        cwd: request.root,
        ...(request.onOutput ? { onOutput: request.onOutput } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        useShell: windows,
      });
      return {
        cancelled: result.cancelled,
        exitCode: result.exitCode,
        success: !result.cancelled && result.exitCode === 0,
      };
    } finally {
      this.running.delete(request.root);
    }
  }
}
