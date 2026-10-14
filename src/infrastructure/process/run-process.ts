import { type ChildProcess, spawn } from "node:child_process";

import { ManifestLensError } from "../../shared/errors";

export interface ProcessResult {
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
}

export interface RunProcessOptions {
  readonly command: string;
  /** Passed verbatim as argv; never interpreted by a shell. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onOutput?: (line: string) => void;
  /** Only needed for Windows `.cmd` shims, with constant, validated arguments. */
  readonly useShell?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

const lineSplitter = (emit: (line: string) => void) => {
  let buffer = "";
  return {
    flush(): void {
      if (buffer !== "") {
        emit(buffer);
        buffer = "";
      }
    },
    push(chunk: Buffer): void {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        emit(line);
      }
    },
  };
};

const terminate = (child: ChildProcess): void => {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
};

/** Runs a subprocess with an argument array, streaming output and honouring cancellation. */
export async function runProcess(
  options: RunProcessOptions
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      resolve({ cancelled: true, exitCode: undefined });
      return;
    }
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.useShell === true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const emit = options.onOutput ?? ((): undefined => undefined);
    const out = lineSplitter(emit);
    const errors = lineSplitter(emit);
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors.push(chunk);
    });
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      terminate(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        new ManifestLensError(
          "process",
          `Could not start "${options.command}": ${error.message}`,
          {
            cause: error,
          }
        )
      );
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      out.flush();
      errors.flush();
      resolve({ cancelled, exitCode: code ?? undefined });
    });
  });
}
