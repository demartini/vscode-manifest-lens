export type LogLevel = "debug" | "error" | "info" | "off" | "warn";

export interface Logger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

const noop = (): undefined => undefined;

export const silentLogger: Logger = {
  debug: noop,
  error: noop,
  info: noop,
  warn: noop,
};
