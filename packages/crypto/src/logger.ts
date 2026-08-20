/**
 * @dstorage/crypto — logger.ts
 * Shared `logger` option validation, used by every SDK class that accepts one.
 */

import { DStorageError, CryptoErrorCode } from "./errors.js";

/**
 * Minimal logger shape accepted by every SDK class.
 * Structurally compatible with `console` — pass `logger: console`.
 */
export interface MinimalLogger {
  log(component: string, msg: string): void;
  warn(component: string, msg: string): void;
  error(component: string, msg: string): void;
  debug?(component: string, msg: string): void;
}

/**
 * Validates a caller-supplied `logger` option at construction time.
 *
 * Catches the common mistake of passing a bound method (e.g. `console.log`)
 * instead of the logger object itself (`console`) — without this check that
 * mistake surfaces later as a cryptic `logger.log is not a function` deep
 * inside an unrelated call stack, often wrapped in an unrelated error's
 * `cause`.
 */
export function assertValidLogger(logger: unknown, contextLabel: string): void {
  if (logger === undefined) return;
  if (typeof logger !== "object" || logger === null) {
    throw new DStorageError(
      CryptoErrorCode.LOGGER_INVALID,
      `[dStorage] ${contextLabel}: logger must be an object with log/warn/error methods, ` +
        `got ${typeof logger}. Did you mean \`logger: console\` instead of \`logger: console.log\`?`,
    );
  }
  for (const method of ["log", "warn", "error"] as const) {
    if (typeof (logger as Record<string, unknown>)[method] !== "function") {
      throw new DStorageError(
        CryptoErrorCode.LOGGER_INVALID,
        `[dStorage] ${contextLabel}: logger.${method} must be a function — ` +
          `logger is compatible with \`console\` (pass \`logger: console\`).`,
      );
    }
  }
}
