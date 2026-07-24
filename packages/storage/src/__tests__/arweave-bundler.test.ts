import { describe, it, expect, vi, afterEach } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { ArweaveBundlerStorageAdapter } from "../adapters/arweave-bundler.js";
import { StorageErrorCode } from "../errors.js";

// 512 zero-bytes encoded as base64url (all 'A's — 170 AAAA groups + AAA).
// Used as the RSA-4096 modulus suffix in compound token test fixtures.
const MODULUS_683 = "A".repeat(683);

const SIGNING_URL = "https://signing.test";

// ── authToken: compound token parsing ──────────────────────────────────────────
//
// The adapter splits on lastIndexOf('.') so the credential part (everything
// before the last dot) may itself contain dots — including a full JWT.

describe("ArweaveBundlerStorageAdapter — authToken parsing", () => {
  it("accepts a plain compound token (<credential>.<modulus>)", () => {
    expect(
      () =>
        new ArweaveBundlerStorageAdapter({
          signingServerUrl: SIGNING_URL,
          authToken: `ds_tok.${MODULUS_683}`,
        }),
    ).not.toThrow();
  });

  it("accepts a compound token whose credential is a JWT (dots in credential)", () => {
    // Simulates: <jwt_header>.<jwt_payload>.<jwt_sig>.<rsa_modulus>
    // lastIndexOf splits at the last dot, so the JWT (three-segment) credential
    // is preserved intact as the Bearer value and the modulus is extracted correctly.
    const jwtCredential = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakeJwtSig";
    expect(
      () =>
        new ArweaveBundlerStorageAdapter({
          signingServerUrl: SIGNING_URL,
          authToken: `${jwtCredential}.${MODULUS_683}`,
        }),
    ).not.toThrow();
  });

  it("throws when the last segment decodes to fewer than 512 bytes (plain JWT, no modulus suffix)", () => {
    // A plain JWT has its signature as the last segment. RS256 produces 256 bytes
    // (344 base64url chars), not 512 — the 512-byte check rejects it at construction.
    const plainJwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.shortSignature";
    let err: unknown;
    try {
      new ArweaveBundlerStorageAdapter({
        signingServerUrl: SIGNING_URL,
        authToken: plainJwt,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_AUTH_TOKEN_KEY,
      message: expect.stringContaining("[dStorage/arweave-bundler]"),
    });
  });

  it("throws when authToken has no dot at all", () => {
    let err: unknown;
    try {
      new ArweaveBundlerStorageAdapter({
        signingServerUrl: SIGNING_URL,
        authToken: "nodottoken",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_AUTH_TOKEN_FORMAT,
      message: expect.stringContaining("[dStorage/arweave-bundler]"),
    });
  });
});

// ── retrieve: transaction ID format validation ────────────────────────────────

describe("ArweaveBundlerStorageAdapter — retrieve ID validation", () => {
  const TX_VALID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 chars

  function adapter() {
    return new ArweaveBundlerStorageAdapter({
      signingServerUrl: SIGNING_URL,
      authToken: `ds_tok.${MODULUS_683}`,
    });
  }

  it("throws before any network call when the id contains path-traversal characters", async () => {
    await expect(adapter().retrieve("../../etc/passwd")).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_TX_ID,
      message: expect.stringContaining("Invalid transaction ID"),
    });
  });

  it("throws for an id shorter than 43 characters", async () => {
    await expect(adapter().retrieve("shortId")).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_TX_ID,
      message: expect.stringContaining("Invalid transaction ID"),
    });
  });

  it("throws for an id longer than 43 characters", async () => {
    await expect(adapter().retrieve(TX_VALID + "A")).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_INVALID_TX_ID,
      message: expect.stringContaining("Invalid transaction ID"),
    });
  });
});

// ── retrieve: content-hash integrity (expectedContentHash anchor) ────────────
//
// The gateway serves both the X-Content-Hash tag AND the data bytes in this
// adapter's retrieve() flow, so a colluding gateway can fabricate an
// internally-consistent (bytes, tag) pair. These tests confirm that supplying
// an expectedContentHash anchor (as @dstorage/core does, from the on-chain
// ChainReference) is verified against instead of trusting the gateway alone.

describe("ArweaveBundlerStorageAdapter — content integrity (expectedContentHash anchor)", () => {
  const TX_ID = "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN"; // 43 chars

  function adapter() {
    return new ArweaveBundlerStorageAdapter({
      signingServerUrl: SIGNING_URL,
      authToken: `ds_tok.${MODULUS_683}`,
    });
  }

  function hexOf(data: Uint8Array): string {
    return Array.from(blake3(data))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function toB64Url(str: string): string {
    return Buffer.from(str, "utf-8").toString("base64url");
  }

  function metaResponse(
    tags: Record<string, string>,
    opts: { contentLength?: string | null } = {},
  ) {
    const text = JSON.stringify({
      tags: Object.entries(tags).map(([name, value]) => ({
        name: toB64Url(name),
        value: toB64Url(value),
      })),
    });
    return {
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-length"
            ? (opts.contentLength ?? null)
            : null,
      },
      // No `.body` stream on this plain mock, so readResponseTextWithLimit()
      // takes its res.text() fallback path.
      text: async () => text,
    };
  }

  function dataResponse(bytes: Uint8Array) {
    return {
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("expectedContentHash anchor overrides a colluding gateway's self-consistent (tampered bytes, forged tag) pair", async () => {
    const originalData = new TextEncoder().encode("original bytes");
    const tamperedData = new TextEncoder().encode("tampered bytes");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        metaResponse({ "X-Content-Hash": hexOf(tamperedData) }),
      )
      .mockResolvedValueOnce(dataResponse(tamperedData));
    vi.stubGlobal("fetch", mockFetch);

    const err = await adapter()
      .retrieve(TX_ID, { expectedContentHash: hexOf(originalData) })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: StorageErrorCode.CONTENT_HASH_MISMATCH,
      message: expect.stringMatching(/hash mismatch/i),
    });
  });

  it("expectedContentHash anchor allows retrieve to succeed when the X-Content-Hash tag is absent", async () => {
    const data = new TextEncoder().encode("retrieved-data");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(metaResponse({}))
      .mockResolvedValueOnce(dataResponse(data));
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      adapter().retrieve(TX_ID, { expectedContentHash: hexOf(data) }),
    ).resolves.toBeDefined();
  });

  it("without an anchor, retrieve still throws when the X-Content-Hash tag is absent", async () => {
    const data = new TextEncoder().encode("retrieved-data");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(metaResponse({}))
      .mockResolvedValueOnce(dataResponse(data));
    vi.stubGlobal("fetch", mockFetch);

    await expect(adapter().retrieve(TX_ID)).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_HASH_TAG_MISSING,
      message: expect.stringContaining("[dStorage/arweave-bundler]"),
    });
  });

  // ── request timeout ─────────────────────────────────────────────────────────

  it("passes an AbortSignal on both the metadata and data fetch when requestTimeoutMs > 0", async () => {
    const data = new TextEncoder().encode("retrieved-data");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(metaResponse({ "X-Content-Hash": hexOf(data) }))
      .mockResolvedValueOnce(dataResponse(data));
    vi.stubGlobal("fetch", mockFetch);

    const timeoutAdapter = new ArweaveBundlerStorageAdapter({
      signingServerUrl: SIGNING_URL,
      authToken: `ds_tok.${MODULUS_683}`,
      requestTimeoutMs: 5_000,
    });
    await timeoutAdapter.retrieve(TX_ID);

    const [, metaInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const [, dataInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(metaInit.signal).toBeInstanceOf(AbortSignal);
    expect(dataInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits signal on both fetches when requestTimeoutMs is 0", async () => {
    const data = new TextEncoder().encode("retrieved-data");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(metaResponse({ "X-Content-Hash": hexOf(data) }))
      .mockResolvedValueOnce(dataResponse(data));
    vi.stubGlobal("fetch", mockFetch);

    const noTimeoutAdapter = new ArweaveBundlerStorageAdapter({
      signingServerUrl: SIGNING_URL,
      authToken: `ds_tok.${MODULUS_683}`,
      requestTimeoutMs: 0,
    });
    await noTimeoutAdapter.retrieve(TX_ID);

    const [, metaInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const [, dataInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(metaInit.signal).toBeUndefined();
    expect(dataInit.signal).toBeUndefined();
  });

  // ── metadata response size limit ────────────────────────────────────────────

  function metaStreamResponse(
    tags: Record<string, string>,
    opts: { chunkSize?: number; contentLength?: string | null } = {},
  ) {
    const text = JSON.stringify({
      tags: Object.entries(tags).map(([name, value]) => ({
        name: toB64Url(name),
        value: toB64Url(value),
      })),
    });
    const bytes = new TextEncoder().encode(text);
    const chunkSize = opts.chunkSize ?? 16;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(bytes.slice(i, i + chunkSize));
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    return {
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-length"
            ? (opts.contentLength ?? null)
            : null,
      },
      body: stream,
      text: async () => text,
    };
  }

  it("throws ARWEAVE_BUNDLER_METADATA_TOO_LARGE when Content-Length exceeds maxMetadataResponseBytes", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        metaStreamResponse(
          { "X-Content-Hash": "a".repeat(64) },
          { contentLength: "99999999" },
        ),
      );
    vi.stubGlobal("fetch", mockFetch);

    const cappedAdapter = new ArweaveBundlerStorageAdapter({
      signingServerUrl: SIGNING_URL,
      authToken: `ds_tok.${MODULUS_683}`,
      maxMetadataResponseBytes: 100,
    });
    await expect(cappedAdapter.retrieve(TX_ID)).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_METADATA_TOO_LARGE,
    });
  });

  it("throws ARWEAVE_BUNDLER_METADATA_TOO_LARGE mid-stream when the metadata body exceeds the cap, even with no Content-Length", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        metaStreamResponse({ "X-Content-Hash": "a".repeat(64) }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const cappedAdapter = new ArweaveBundlerStorageAdapter({
      signingServerUrl: SIGNING_URL,
      authToken: `ds_tok.${MODULUS_683}`,
      maxMetadataResponseBytes: 50,
    });
    await expect(cappedAdapter.retrieve(TX_ID)).rejects.toMatchObject({
      code: StorageErrorCode.ARWEAVE_BUNDLER_METADATA_TOO_LARGE,
    });
  });
});
