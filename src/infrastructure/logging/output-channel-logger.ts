import * as vscode from "vscode";

import type { LogLevel, Logger } from "../../shared/logger";
import { redactSecrets } from "../../shared/redact";

const ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 4,
  error: 1,
  info: 3,
  off: 0,
  warn: 2,
};

const stringify = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** A logger that writes redacted, level-filtered lines to a dedicated output channel. */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  readonly channel: vscode.OutputChannel;
  private level: LogLevel = "warn";

  constructor() {
    this.channel = vscode.window.createOutputChannel("Manifest Lens");
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Writes a line regardless of the configured level (user-facing reports). */
  report(line: string): void {
    this.channel.appendLine(redactSecrets(line));
  }

  show(): void {
    this.channel.show(true);
  }

  debug(message: string, ...data: unknown[]): void {
    this.write("debug", message, data);
  }

  info(message: string, ...data: unknown[]): void {
    this.write("info", message, data);
  }

  warn(message: string, ...data: unknown[]): void {
    this.write("warn", message, data);
  }

  error(message: string, ...data: unknown[]): void {
    this.write("error", message, data);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(
    level: Exclude<LogLevel, "off">,
    message: string,
    data: unknown[]
  ): void {
    if (ORDER[level] > ORDER[this.level]) {
      return;
    }
    const extra = data.length > 0 ? ` ${data.map(stringify).join(" ")}` : "";
    const stamp = new Date().toISOString();
    this.channel.appendLine(
      redactSecrets(`${stamp} [${level}] ${message}${extra}`)
    );
  }
}
