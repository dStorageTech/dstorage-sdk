import { describe, it, expect } from "vitest";
import { assertValidLogger } from "../logger.js";
import { CryptoErrorCode } from "../errors.js";

describe("assertValidLogger", () => {
  it("accepts undefined (logger omitted)", () => {
    expect(() => assertValidLogger(undefined, "TestAdapter")).not.toThrow();
  });

  it("accepts console", () => {
    expect(() => assertValidLogger(console, "TestAdapter")).not.toThrow();
  });

  it("accepts a plain object with log/warn/error", () => {
    const logger = { log() {}, warn() {}, error() {} };
    expect(() => assertValidLogger(logger, "TestAdapter")).not.toThrow();
  });

  it("throws LOGGER_INVALID when passed console.log instead of console", () => {
    const err = ((): unknown => {
      try {
        assertValidLogger(console.log, "TestAdapter");
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({
      code: CryptoErrorCode.LOGGER_INVALID,
      message: expect.stringContaining("TestAdapter"),
    });
    expect((err as Error).message).toContain("console.log");
  });

  it("throws LOGGER_INVALID for a string", () => {
    expect(() => assertValidLogger("console", "TestAdapter")).toThrow(
      /logger must be an object/,
    );
  });

  it("throws LOGGER_INVALID when a required method is missing", () => {
    const logger = { log() {}, warn() {} }; // missing error()
    expect(() => assertValidLogger(logger, "TestAdapter")).toThrow(
      /logger\.error must be a function/,
    );
  });
});
