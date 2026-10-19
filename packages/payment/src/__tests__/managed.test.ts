/**
 * @dstorage/payment — ManagedPaymentAdapter tests
 */

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import Arweave from "arweave";
import {
  ManagedPaymentAdapter,
  parseSignTxResponse,
  assertOwnerKeyMatch,
} from "../adapters/managed.js";
import type { PaymentQuote } from "../types.js";
import { PaymentErrorCode } from "../errors.js";

const SIGNING_SERVER_URL = "https://signing.example.com";

const BASE_CONFIG = {
  network: "arweave" as const,
  type: "storage" as const,
};

function makeAdapter() {
  return new ManagedPaymentAdapter({
    ...BASE_CONFIG,
    managedPayment: {
      signingServerUrl: SIGNING_SERVER_URL,
      authToken: "tok_test",
    },
  });
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
        new ManagedPaymentAdapter({
          ...BASE_CONFIG,
          managedPayment: {
            signingServerUrl: SIGNING_SERVER_URL,
            authToken: "tok_abc123",
          },
        }),
    ).not.toThrow();
  });

  it("throws at construction when authToken is missing", () => {
    let err: unknown;
    try {
      new ManagedPaymentAdapter({
        ...BASE_CONFIG,
        // @ts-expect-error — intentionally omitting required authToken to test runtime guard
        managedPayment: { signingServerUrl: SIGNING_SERVER_URL },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_TOKEN_REQUIRED,
      message: expect.stringMatching(/authToken/i),
    });
  });

  it("throws at construction when authToken is an empty string", () => {
    let err: unknown;
    try {
      new ManagedPaymentAdapter({
        ...BASE_CONFIG,
        managedPayment: { signingServerUrl: SIGNING_SERVER_URL, authToken: "" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_TOKEN_REQUIRED,
      message: expect.stringMatching(/authToken/i),
    });
  });

  it("throws at construction when authToken is whitespace only", () => {
    let err: unknown;
    try {
      new ManagedPaymentAdapter({
        ...BASE_CONFIG,
        managedPayment: {
          signingServerUrl: SIGNING_SERVER_URL,
          authToken: "   ",
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_TOKEN_REQUIRED,
      message: expect.stringMatching(/authToken/i),
    });
  });

  it("accepts a compound token whose credential part is a JWT (dots in credential)", () => {
    // A JWT credential produces a token with four dot-separated segments:
    // <jwt_header>.<jwt_payload>.<jwt_sig>.<rsa_modulus_683_chars>
    // _parseAuthToken uses lastIndexOf so the full JWT is returned as the
    // Bearer credential and the modulus suffix is stripped correctly.
    const modulus683 = "A".repeat(683);
    const jwtCredential = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakeJwtSig";
    expect(
      () =>
        new ManagedPaymentAdapter({
          ...BASE_CONFIG,
          managedPayment: {
            signingServerUrl: SIGNING_SERVER_URL,
            authToken: `${jwtCredential}.${modulus683}`,
          },
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
    let err: unknown;
    try {
      parseSignTxResponse({ ...VALID_RESPONSE, success: false });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_SERVER_FAILURE,
      message: expect.stringMatching(/success/i),
    });
  });

  it("throws when txId is missing", () => {
    const { txId: _, ...rest } = VALID_RESPONSE;
    let err: unknown;
    try {
      parseSignTxResponse(rest);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_MISSING_FIELD,
      message: expect.stringMatching(/txId/i),
    });
  });

  it("throws when txId is not a string", () => {
    let err: unknown;
    try {
      parseSignTxResponse({ ...VALID_RESPONSE, txId: 12345 });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_MISSING_FIELD,
      message: expect.stringMatching(/txId/i),
    });
  });

  it("throws when signature is missing", () => {
    const { signature: _, ...rest } = VALID_RESPONSE;
    let err: unknown;
    try {
      parseSignTxResponse(rest);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_MISSING_FIELD,
      message: expect.stringMatching(/signature/i),
    });
  });

  it("throws when publicKey is missing", () => {
    const { publicKey: _, ...rest } = VALID_RESPONSE;
    let err: unknown;
    try {
      parseSignTxResponse(rest);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_MISSING_FIELD,
      message: expect.stringMatching(/publicKey/i),
    });
  });

  it("throws when txAmount is missing", () => {
    const { txAmount: _, ...rest } = VALID_RESPONSE;
    let err: unknown;
    try {
      parseSignTxResponse(rest);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_MISSING_FIELD,
      message: expect.stringMatching(/txAmount/i),
    });
  });

  it("throws when serviceFee is missing", () => {
    const { serviceFee: _, ...rest } = VALID_RESPONSE;
    let err: unknown;
    try {
      parseSignTxResponse(rest);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_MISSING_FIELD,
      message: expect.stringMatching(/serviceFee/i),
    });
  });

  it("throws when the response is not an object", () => {
    let err1: unknown;
    try {
      parseSignTxResponse("not an object");
    } catch (e) {
      err1 = e;
    }
    let err2: unknown;
    try {
      parseSignTxResponse(null);
    } catch (e) {
      err2 = e;
    }
    let err3: unknown;
    try {
      parseSignTxResponse(42);
    } catch (e) {
      err3 = e;
    }
    expect(err1).toMatchObject({
      code: PaymentErrorCode.MANAGED_NON_OBJECT_RESPONSE,
    });
    expect(err2).toMatchObject({
      code: PaymentErrorCode.MANAGED_NON_OBJECT_RESPONSE,
    });
    expect(err3).toMatchObject({
      code: PaymentErrorCode.MANAGED_NON_OBJECT_RESPONSE,
    });
  });

  it("strips ANSI escapes and HTML from the success:false error message (N6)", () => {
    const malicious = {
      ...VALID_RESPONSE,
      success: false,
      error: "\x1b[31mred\x1b[0m<script>alert(1)</script>",
    };
    let msg = "";
    try {
      parseSignTxResponse(malicious);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toMatch(/\x1b/);
    expect(msg).not.toMatch(/<script>/i);
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
    let err: unknown;
    try {
      assertOwnerKeyMatch("B".repeat(683), PINNED);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_PUBLIC_KEY_MISMATCH,
      message: expect.stringMatching(/does not match the pinned key/i),
    });
  });

  it("throws on any mismatch, even a single-character difference", () => {
    const tampered = "A".repeat(682) + "B";
    let err: unknown;
    try {
      assertOwnerKeyMatch(tampered, PINNED);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: PaymentErrorCode.MANAGED_PUBLIC_KEY_MISMATCH,
      message: expect.stringMatching(/\[dStorage\/managed-payment\]/),
    });
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
      managedPayment: {
        ...MIDNIGHT_CONFIG.managedPayment,
        requestTimeoutMs: 5_000,
      },
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
  network: "midnight" as const,
  type: "chain" as const,
  managedPayment: {
    signingServerUrl: SIGNING_SERVER_URL,
    authToken: "tok_abc123",
  },
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
      managedPayment: {
        ...MIDNIGHT_CONFIG.managedPayment,
        requestTimeoutMs: 50,
      },
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
      managedPayment: {
        ...MIDNIGHT_CONFIG.managedPayment,
        requestTimeoutMs: 5_000,
      },
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

// ── Midnight sign-tx request body ─────────────────────────────────────────────

describe("ManagedPaymentAdapter — Midnight networkId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function captureBody(
    networkId?: string,
  ): Promise<Record<string, unknown>> {
    let sent: string | undefined;
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      sent = init?.body as string;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            txId: "a".repeat(43),
            signature: "c2lnbmF0dXJl",
            publicKey: "cHVibGljS2V5",
            txAmount: "0.001",
            serviceFee: "0.0001",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    const adapter = new ManagedPaymentAdapter({
      ...MIDNIGHT_CONFIG,
      ...(networkId !== undefined ? { networkId } : {}),
    });
    await adapter.pay({
      network: "midnight",
      txData: "deadbeef",
      dataSizeBytes: 0,
      expiresAt: Date.now() + 60_000,
    });
    return JSON.parse(sent ?? "{}") as Record<string, unknown>;
  }

  it("sends the configured networkId in the sign-tx request", async () => {
    const body = await captureBody("preview");
    expect(body).toMatchObject({ network: "midnight", networkId: "preview" });
  });

  it("omits networkId when none is configured", async () => {
    const body = await captureBody();
    expect(body).not.toHaveProperty("networkId");
  });
});

// ── Quote TTL enforcement ─────────────────────────────────────────────────────

describe("ManagedPaymentAdapter — quote TTL", () => {
  it("pay() throws when the quote has already expired", async () => {
    const adapter = makeAdapter();
    const expiredQuote = makeQuote({ expiresAt: Date.now() - 1 });
    await expect(adapter.pay(expiredQuote)).rejects.toMatchObject({
      code: PaymentErrorCode.MANAGED_QUOTE_EXPIRED,
      message: expect.stringContaining("[dStorage/payment]"),
    });
  });

  it("pay() error message mentions expiry", async () => {
    const adapter = makeAdapter();
    const expiredQuote = makeQuote({ expiresAt: Date.now() - 5_000 });
    await expect(adapter.pay(expiredQuote)).rejects.toMatchObject({
      code: PaymentErrorCode.MANAGED_QUOTE_EXPIRED,
      message: expect.stringMatching(/expir/i),
    });
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

// ── managedmock: txData prefixing ─────────────────────────────────────────────
//
// A single store() call pays once via the storage adapter and once via the
// chain adapter, both hashing the same underlying bytes — without a prefix
// the two signing-server requests would be byte-identical. txData is
// prefixed with "{type}:{adapter name}:" so the two legs (and different
// adapters of the same type, e.g. MockChainAdapter vs.
// MidnightSimulatorChainAdapter) are distinguishable on the wire.

describe("ManagedPaymentAdapter — managedmock txData prefixing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubSuccessResponseCapturingBody(): { body: () => string } {
    let capturedBody = "";
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            txId: "a".repeat(43),
            signature: "c2lnbmF0dXJl",
            publicKey: "cHVibGljS2V5",
            txAmount: "0.001",
            serviceFee: "0.0001",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    return { body: () => capturedBody };
  }

  it("prefixes txData with type and adapter name for a chain adapter", async () => {
    const capture = stubSuccessResponseCapturingBody();
    const adapter = new ManagedPaymentAdapter({
      network: "managedmock",
      type: "chain",
      managedPayment: {
        signingServerUrl: SIGNING_SERVER_URL,
        authToken: "tok_test",
      },
    });
    await adapter.pay({
      network: "mock",
      txData: "deadbeef",
      dataSizeBytes: 0,
      expiresAt: Date.now() + 60_000,
    });
    const sent = JSON.parse(capture.body()) as { txData: string };
    expect(sent.txData).toBe("chain:mock:deadbeef");
  });

  it("prefixes txData with type and adapter name for a storage adapter", async () => {
    const capture = stubSuccessResponseCapturingBody();
    const adapter = new ManagedPaymentAdapter({
      network: "managedmock",
      type: "storage",
      managedPayment: {
        signingServerUrl: SIGNING_SERVER_URL,
        authToken: "tok_test",
      },
    });
    await adapter.pay({
      network: "mock",
      txData: "deadbeef",
      dataSizeBytes: 0,
      expiresAt: Date.now() + 60_000,
    });
    const sent = JSON.parse(capture.body()) as { txData: string };
    expect(sent.txData).toBe("storage:mock:deadbeef");
  });

  it("distinguishes different chain adapter names sharing the same type", async () => {
    const capture = stubSuccessResponseCapturingBody();
    const adapter = new ManagedPaymentAdapter({
      network: "managedmock",
      type: "chain",
      managedPayment: {
        signingServerUrl: SIGNING_SERVER_URL,
        authToken: "tok_test",
      },
    });
    await adapter.pay({
      network: "midnight",
      txData: "deadbeef",
      dataSizeBytes: 0,
      expiresAt: Date.now() + 60_000,
    });
    const sent = JSON.parse(capture.body()) as { txData: string };
    expect(sent.txData).toBe("chain:midnight:deadbeef");
  });

  it("falls back to the literal string 'mock' when no txData is provided", async () => {
    const capture = stubSuccessResponseCapturingBody();
    const adapter = new ManagedPaymentAdapter({
      network: "managedmock",
      type: "chain",
      managedPayment: {
        signingServerUrl: SIGNING_SERVER_URL,
        authToken: "tok_test",
      },
    });
    await adapter.pay({
      network: "mock",
      dataSizeBytes: 0,
      expiresAt: Date.now() + 60_000,
    });
    const sent = JSON.parse(capture.body()) as { txData: string };
    expect(sent.txData).toBe("mock");
  });
});

// ── testMode (Arweave) ────────────────────────────────────────────────────────
//
// With managedPayment.testMode the sign-tx request carries network "TEST"; the
// signing server returns fake signing data (as the portal's processTest does),
// so the adapter must sign the tx locally with walletKey for arlocal to accept it.

describe("ManagedPaymentAdapter — testMode (Arweave)", () => {
  let walletKey: Record<string, string>;
  let arweave: Arweave;

  beforeAll(async () => {
    arweave = Arweave.init({});
    walletKey = (await arweave.wallets.generate()) as unknown as Record<
      string,
      string
    >;
  }, 30_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Portal-shaped TEST response: random bytes, not a valid Arweave signature.
  const FAKE_TX_ID = "t".repeat(43);

  function stubGatewayAndSigningServer(): { body: () => string } {
    let capturedBody = "";
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url.includes("/api/service/sign-tx")) {
        capturedBody = String(init?.body ?? "");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              txId: FAKE_TX_ID,
              signature: "f".repeat(86),
              publicKey: "p".repeat(43),
              txAmount: "0.001",
              serviceFee: "0.0001",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url.includes("/tx_anchor")) {
        return Promise.resolve(new Response("a".repeat(64), { status: 200 }));
      }
      if (url.includes("/price/")) {
        return Promise.resolve(new Response("12345", { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    return { body: () => capturedBody };
  }

  function makeTestModeAdapter(authToken = "tok_test") {
    return new ManagedPaymentAdapter({
      ...BASE_CONFIG,
      walletKey,
      managedPayment: {
        signingServerUrl: SIGNING_SERVER_URL,
        authToken,
        testMode: true,
      },
    });
  }

  async function payWithUpload(adapter: ManagedPaymentAdapter) {
    const data = new TextEncoder().encode("test-mode payload");
    adapter.provideUploadData(data, {
      "Content-Type": "application/octet-stream",
    });
    const receipt = await adapter.pay(
      makeQuote({ dataSizeBytes: data.byteLength }),
    );
    return { data, receipt };
  }

  it("throws when testMode is set on Arweave without a walletKey", () => {
    try {
      new ManagedPaymentAdapter({
        ...BASE_CONFIG,
        managedPayment: {
          signingServerUrl: SIGNING_SERVER_URL,
          authToken: "tok_test",
          testMode: true,
        },
      });
      expect.unreachable("constructor should have thrown");
    } catch (err) {
      expect((err as { code?: number }).code).toBe(
        PaymentErrorCode.MANAGED_TEST_MODE_WALLET_REQUIRED,
      );
      expect((err as Error).message).toMatch(/^\[dStorage\/managed-payment\]/);
      expect((err as Error).message).toContain("createWithTestWallet");
    }
  });

  it("does not require a walletKey for testMode on non-Arweave networks", () => {
    expect(
      () =>
        new ManagedPaymentAdapter({
          network: "managedmock",
          type: "chain",
          managedPayment: {
            signingServerUrl: SIGNING_SERVER_URL,
            authToken: "tok_test",
            testMode: true,
          },
        }),
    ).not.toThrow();
  });

  it("sends the stripped Arweave tx with network TEST", async () => {
    const capture = stubGatewayAndSigningServer();
    await payWithUpload(makeTestModeAdapter());

    const sent = JSON.parse(capture.body()) as {
      network: string;
      txData: { data: string; data_root: string; data_size: string };
    };
    expect(sent.network).toBe("TEST");
    expect(sent.txData.data).toBe("");
    expect(sent.txData.data_root).not.toBe("");
    expect(sent.txData.data_size).toBe(
      String(new TextEncoder().encode("test-mode payload").byteLength),
    );
  });

  it("signs the tx locally with walletKey instead of applying the fake signature", async () => {
    stubGatewayAndSigningServer();
    const adapter = makeTestModeAdapter();
    const { data, receipt } = await payWithUpload(adapter);

    expect(receipt.txHash).toBe(FAKE_TX_ID);

    const signed = adapter.consumeSignedUpload();
    expect(signed).not.toBeNull();
    const tx = signed!.tx;
    expect(tx.owner).toBe(walletKey.n);
    expect(tx.id).not.toBe(FAKE_TX_ID);
    expect(tx.data).toEqual(data);
    expect(await arweave.transactions.verify(tx)).toBe(true);
  });

  it("ignores a pinned server key from a compound authToken", async () => {
    stubGatewayAndSigningServer();
    const adapter = makeTestModeAdapter(`tok_test.${"A".repeat(683)}`);
    await payWithUpload(adapter);

    const tx = adapter.consumeSignedUpload()!.tx;
    expect(tx.owner).toBe(walletKey.n);
    expect(await arweave.transactions.verify(tx)).toBe(true);
  });
});

// ── Remote signing (Arweave) ──────────────────────────────────────────────────
//
// The server's signing wallet is the tx owner (and fee payer), so the stripped
// tx is sent with an empty owner and the owner returned by the server is applied.
// A compound token's suffix is the server's bundler wallet key, not this signer,
// so it must neither be sent as the owner nor pin the response.

describe("ManagedPaymentAdapter — remote signing (Arweave)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SERVER_TX_ID = "s".repeat(43);
  const SERVER_OWNER = "B".repeat(683);

  function stubGatewayAndSigningServer(): { body: () => string } {
    let capturedBody = "";
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url.includes("/api/service/sign-tx")) {
        capturedBody = String(init?.body ?? "");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              txId: SERVER_TX_ID,
              signature: "f".repeat(683),
              publicKey: SERVER_OWNER,
              txAmount: "0.001",
              serviceFee: "0.0001",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url.includes("/tx_anchor")) {
        return Promise.resolve(new Response("a".repeat(64), { status: 200 }));
      }
      if (url.includes("/price/")) {
        return Promise.resolve(new Response("12345", { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    return { body: () => capturedBody };
  }

  async function payWithUpload(authToken: string) {
    const adapter = new ManagedPaymentAdapter({
      ...BASE_CONFIG,
      managedPayment: { signingServerUrl: SIGNING_SERVER_URL, authToken },
    });
    const data = new TextEncoder().encode("remote-signing payload");
    adapter.provideUploadData(data, {
      "Content-Type": "application/octet-stream",
    });
    await adapter.pay(makeQuote({ dataSizeBytes: data.byteLength }));
    return adapter;
  }

  it("sends the stripped tx with an empty owner (plain token)", async () => {
    const capture = stubGatewayAndSigningServer();
    await payWithUpload("tok_test");

    const sent = JSON.parse(capture.body()) as { txData: { owner: string } };
    expect(sent.txData.owner).toBe("");
  });

  it("does not send a compound token's bundler key as the owner", async () => {
    const capture = stubGatewayAndSigningServer();
    await payWithUpload(`tok_test.${"A".repeat(683)}`);

    const sent = JSON.parse(capture.body()) as { txData: { owner: string } };
    expect(sent.txData.owner).toBe("");
  });

  it("applies the server's owner even when it differs from a compound token's bundler key", async () => {
    stubGatewayAndSigningServer();
    const adapter = await payWithUpload(`tok_test.${"A".repeat(683)}`);

    const tx = adapter.consumeSignedUpload()!.tx;
    expect(tx.owner).toBe(SERVER_OWNER);
    expect(tx.id).toBe(SERVER_TX_ID);
  });
});
