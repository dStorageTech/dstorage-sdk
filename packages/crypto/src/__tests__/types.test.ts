import { describe, it, expect } from "vitest";
import { base64urlToBytes, bytesToBase64url } from "../types.js";
import { CryptoErrorCode } from "../errors.js";

describe("base64urlToBytes / bytesToBase64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64, 32]);
    const encoded = bytesToBase64url(bytes);
    expect(base64urlToBytes(encoded)).toEqual(bytes);
  });

  it("throws BASE64URL_INVALID on malformed input", () => {
    const err = ((): unknown => {
      try {
        base64urlToBytes("not!valid+base64/url==");
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({
      code: CryptoErrorCode.BASE64URL_INVALID,
      message: expect.stringContaining("[dStorage/crypto]"),
    });
  });

  it("does not echo the malformed input into the error message", () => {
    const secretLookingInput = "SECRET_WRAPPED_KEY_FRAGMENT!!!not-base64url";
    const err = ((): unknown => {
      try {
        base64urlToBytes(secretLookingInput);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect((err as Error).message).not.toContain(secretLookingInput);
    expect((err as Error).message).not.toContain("SECRET_WRAPPED_KEY_FRAGMENT");
  });

  it("still reports the input length for debuggability", () => {
    const input = "x".repeat(50) + "!"; // invalid char at the end
    const err = ((): unknown => {
      try {
        base64urlToBytes(input);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect((err as Error).message).toContain(String(input.length));
  });
});
