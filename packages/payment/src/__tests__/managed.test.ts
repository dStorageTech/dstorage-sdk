/**
 * @dstorage/payment — ManagedPaymentAdapter tests
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ManagedPaymentAdapter,
  parseSignTxResponse,
  assertOwnerKeyMatch,
} from "../adapters/managed.js";
import type { PaymentQuote } from "../types.js";

const BASE_CONFIG = {
  signingServerUrl: "https://signing.example.com",
  network: "arweave" as const,
  type: "storage" as const,
};

function makeAdapter() {
  return new ManagedPaymentAdapter({ ...BASE_CONFIG, authToken: "tok_test" });
}

function makeQuote(overrides: Partial<PaymentQuote> = {}): PaymentQuote {
  return {
    token: "AR",
    amount: "0.000001",
    network: "arweave",
    type: "storage",
    dataSizeBytes: 1024,
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}

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

  it("accepts a compound token whose credential part is a JWT (dots in credential)", () => {
    // A JWT credential produces a token with four dot-separated segments:
    // <jwt_header>.<jwt_payload>.<jwt_sig>.<rsa_modulus_683_chars>
    // _extractCredential uses lastIndexOf so the full JWT is returned as the
    // Bearer credential and the modulus suffix is stripped correctly.
    const modulus683 = "A".repeat(683);
    const jwtCredential = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakeJwtSig";
    expect(
      () =>
        new ManagedPaymentAdapter({
          ...BASE_CONFIG,
          authToken: `${jwtCredential}.${modulus683}`,
        }),
    ).not.toThrow();
  });
});

// ── Security: signing server response validation ───────────────────────────────
//
// The raw JSON from the signing server must be validated before any of its
// fields are trusted. A missing field, wrong type, or success:false must throw
// immediately rather than silently propagating a corrupt txId/signature/owner
// into the transaction.

const VALID_RESPONSE = {
  success: true,
  txId: "a".repeat(43),
  signature: "c2lnbmF0dXJl",
  publicKey: "cHVibGljS2V5",
  txAmount: "0.001",
  serviceFee: "0.0001",
};

describe("parseSignTxResponse — signing server response validation", () => {
  it("accepts a fully valid response", () => {
    expect(() => parseSignTxResponse(VALID_RESPONSE)).not.toThrow();
  });

  it("throws when success is false", () => {
    expect(() =>
      parseSignTxResponse({ ...VALID_RESPONSE, success: false }),
    ).toThrow(/success/i);
  });

  it("throws when txId is missing", () => {
    const { txId: _, ...rest } = VALID_RESPONSE;
    expect(() => parseSignTxResponse(rest)).toThrow(/txId/i);
  });

  it("throws when txId is not a string", () => {
    expect(() =>
      parseSignTxResponse({ ...VALID_RESPONSE, txId: 12345 }),
    ).toThrow(/txId/i);
  });

  it("throws when signature is missing", () => {
    const { signature: _, ...rest } = VALID_RESPONSE;
    expect(() => parseSignTxResponse(rest)).toThrow(/signature/i);
  });

  it("throws when publicKey is missing", () => {
    const { publicKey: _, ...rest } = VALID_RESPONSE;
    expect(() => parseSignTxResponse(rest)).toThrow(/publicKey/i);
  });

  it("throws when txAmount is missing", () => {
    const { txAmount: _, ...rest } = VALID_RESPONSE;
    expect(() => parseSignTxResponse(rest)).toThrow(/txAmount/i);
  });

  it("throws when serviceFee is missing", () => {
    const { serviceFee: _, ...rest } = VALID_RESPONSE;
    expect(() => parseSignTxResponse(rest)).toThrow(/serviceFee/i);
  });

  it("throws when the response is not an object", () => {
    expect(() => parseSignTxResponse("not an object")).toThrow();
    expect(() => parseSignTxResponse(null)).toThrow();
    expect(() => parseSignTxResponse(42)).toThrow();
  });
});

// ── Security: signing server owner-key pinning (N5) ──────────────────────────
//
// When the auth token carries a pinned RSA modulus (compound token
// <credential>.<modulus>), the owner key returned by the signing server in the
// sign-tx response must match it. Without this check a compromised or MITM'd
// signing server could return an attacker-controlled (publicKey, signature)
// pair, which the Arweave path would then apply via tx.setSignature({ owner }),
// making the attacker the on-chain owner of the upload.

describe("assertOwnerKeyMatch — signing server owner-key pinning", () => {
  const PINNED = "A".repeat(683);

  it("is a no-op when no key was pinned (plain auth token)", () => {
    expect(() => assertOwnerKeyMatch("anything", undefined)).not.toThrow();
  });

  it("passes when the response key matches the pinned key", () => {
    expect(() => assertOwnerKeyMatch(PINNED, PINNED)).not.toThrow();
  });

  it("throws when the response key differs from the pinned key", () => {
    expect(() => assertOwnerKeyMatch("B".repeat(683), PINNED)).toThrow(
      /does not match the pinned key/i,
    );
  });

  it("throws on any mismatch, even a single-character difference", () => {
    const tampered = "A".repeat(682) + "B";
    expect(() => assertOwnerKeyMatch(tampered, PINNED)).toThrow(
      /\[dStorage\/managed-payment\]/,
    );
  });
});

// ── Security: server error body sanitisation ─────────────────────────────────
//
// The signing server's error response body is included in the thrown Error
// message for debugging. A hostile or compromised server could abuse this by
// returning a very long body (memory / log-flood), HTML/script tags (UI
// injection if the message is rendered), or control characters (log-injection
// / terminal escape attacks). The adapter must sanitise the body before
// embedding it.

describe("ManagedPaymentAdapter — server error body sanitisation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockErrorResponse(body: string, status = 400): void {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(body, {
          status,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );
  }

  async function getErrorMessage(body: string): Promise<string> {
    mockErrorResponse(body);
    const adapter = new ManagedPaymentAdapter({
      ...MIDNIGHT_CONFIG,
      requestTimeoutMs: 5_000,
    });
    try {
      await adapter.pay({
        token: "DUST",
        amount: "0",
        type: "chain",
        network: "midnight",
        txData: "deadbeef",
        dataSizeBytes: 0,
        expiresAt: Date.now() + 60_000,
      });
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  }

  it("truncates very long server error bodies in the thrown message", async () => {
    const longBody = "x".repeat(10_000);
    const msg = await getErrorMessage(longBody);
    expect(msg.length).toBeLessThan(500);
  });

  it("strips HTML tags from the server error body", async () => {
    const msg = await getErrorMessage(
      '<script>alert("xss")</script>Unauthorized',
    );
    expect(msg).not.toContain("<script>");
    expect(msg).not.toContain("</script>");
    expect(msg).toContain("Unauthorized");
  });

  it("strips ASCII control characters from the server error body", async () => {
    const msg = await getErrorMessage("Bad\x00request\x1b[31mred\x1b[0m");
    expect(msg).not.toMatch(/[\x00-\x1f]/);
  });

  it("preserves a plain ASCII error message unchanged", async () => {
    const msg = await getErrorMessage("invalid token");
    expect(msg).toContain("invalid token");
  });
});

// ── Security: fetch request timeout ──────────────────────────────────────────
//
// The fetch call to the signing server must not block indefinitely. A hung or
// unresponsive signing server should not stall the entire upload flow. The
// adapter must abort the in-flight request after `requestTimeoutMs` and throw
// a recognisable error so the caller can retry or surface a meaningful message.

const MIDNIGHT_CONFIG = {
  signingServerUrl: "https://signing.example.com",
  network: "midnight" as const,
  type: "chain" as const,
  authToken: "tok_abc123",
};

describe("ManagedPaymentAdapter — request timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when the signing server does not respond within requestTimeoutMs", async () => {
    // Mock fetch: resolves only when the AbortSignal fires — otherwise hangs.
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            (err as NodeJS.ErrnoException).code = "ABORT_ERR";
            reject(err);
          });
          // Never resolves on its own — simulates a hung signing server.
        }),
    );

    const adapter = new ManagedPaymentAdapter({
      ...MIDNIGHT_CONFIG,
      requestTimeoutMs: 50,
    });

    await expect(
      adapter.pay({
        token: "DUST",
        amount: "0",
        type: "chain",
        network: "midnight",
        txData: "deadbeef",
        dataSizeBytes: 0,
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/abort|timed?[\s-]?out/i);
  }, 500); // test-level timeout: without the fix the fetch hangs, causing this to fail here

  it("does not throw when the server responds before the timeout", async () => {
    const successBody = JSON.stringify({
      success: true,
      txId: "a".repeat(43),
      signature: "c2lnbmF0dXJl",
      publicKey: "cHVibGljS2V5",
      txAmount: "0.001",
      serviceFee: "0.0001",
    });

    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(successBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const adapter = new ManagedPaymentAdapter({
      ...MIDNIGHT_CONFIG,
      requestTimeoutMs: 5_000,
    });

    await expect(
      adapter.pay({
        token: "DUST",
        amount: "0",
        type: "chain",
        network: "midnight",
        txData: "deadbeef",
        dataSizeBytes: 0,
        expiresAt: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({ token: "DUST" });
  });
});

// ── Quote TTL enforcement ─────────────────────────────────────────────────────

describe("ManagedPaymentAdapter — quote TTL", () => {
  it("pay() throws when the quote has already expired", async () => {
    const adapter = makeAdapter();
    const expiredQuote = makeQuote({ expiresAt: Date.now() - 1 });
    await expect(adapter.pay(expiredQuote)).rejects.toThrow(
      "[dStorage/payment]",
    );
  });

  it("pay() error message mentions expiry", async () => {
    const adapter = makeAdapter();
    const expiredQuote = makeQuote({ expiresAt: Date.now() - 5_000 });
    await expect(adapter.pay(expiredQuote)).rejects.toThrow(/expir/i);
  });

  it("pay() does not throw an expiry error for a valid quote", async () => {
    const adapter = makeAdapter();
    const validQuote = makeQuote({ expiresAt: Date.now() + 60_000 });
    // pay() will fail later (network call) — we only care it is not an expiry error.
    const result = await adapter.pay(validQuote).catch((err: unknown) => err);
    if (result instanceof Error) {
      expect(result.message).not.toMatch(/expir/i);
    }
  });
});
