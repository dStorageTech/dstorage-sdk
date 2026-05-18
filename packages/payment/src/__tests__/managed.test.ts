/**
 * @dstorage/payment — ManagedPaymentAdapter tests
 */

import { describe, it, expect } from "vitest";
import { ManagedPaymentAdapter } from "../adapters/managed.js";

const BASE_CONFIG = {
  signingServerUrl: "https://signing.example.com",
  network: "arweave" as const,
  type: "storage" as const,
};

// ── Security: authToken validation ────────────────────────────────────────────
//
// An empty authToken (e.g. from an unresolved env var) must not silently
// degrade to anonymous requests. The constructor must reject it immediately
// so the misconfiguration is caught at startup, not during a live signing call.

describe("ManagedPaymentAdapter — authToken validation", () => {
  it("constructs successfully when authToken is a non-empty string", () => {
    expect(
      () =>
        new ManagedPaymentAdapter({ ...BASE_CONFIG, authToken: "tok_abc123" }),
    ).not.toThrow();
  });

  it("throws at construction when authToken is missing", () => {
    expect(
      // @ts-expect-error — intentionally omitting required authToken to test runtime guard
      () => new ManagedPaymentAdapter({ ...BASE_CONFIG }),
    ).toThrow(/authToken/i);
  });

  it("throws at construction when authToken is an empty string", () => {
    expect(
      () => new ManagedPaymentAdapter({ ...BASE_CONFIG, authToken: "" }),
    ).toThrow(/authToken/i);
  });

  it("throws at construction when authToken is whitespace only", () => {
    expect(
      () => new ManagedPaymentAdapter({ ...BASE_CONFIG, authToken: "   " }),
    ).toThrow(/authToken/i);
  });
});
