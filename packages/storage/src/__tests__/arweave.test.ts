/**
 * ArweaveStorageAdapter tests
 *
 * All tests run without real network calls — arweave-js is mocked at the
 * module level so the suite is fast, offline, and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { ArweaveStorageAdapter, ARWEAVE_MAINNET } from "../adapters/arweave.js";
import { StorageErrorCode } from "../errors.js";
import { PaymentErrorCode } from "@dstorage/payment";

// ── test tx IDs — all exactly 43 base64url chars (valid Arweave format) ──────

const TX_MOCK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TX_UNKNOWN = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TX_BASIC = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const TX_TAMPERED = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const TX_NO_HASH = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const TX_SKIP = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
const TX_UNINDEXED = "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";
const TX_HUGE = "HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";
const TX_BIG = "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII";
const TX_BIG_SKIP = "JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ";
const TX_OK = "KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK";
const TX_ANCHOR_OVERRIDE = "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";
const TX_ANCHOR_NO_TAG = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";

// ── arweave-js mock ───────────────────────────────────────────────────────────

const mockTx = {
  id: TX_MOCK,
  addTag: vi.fn(),
  data: "",
};

// Mutable state for the per-test uploader mock.
let uploaderState = { calls: 0, totalChunks: 1 };

const mockUploader = {
  get isComplete() {
    return uploaderState.calls >= uploaderState.totalChunks;
  },
  get uploadedChunks() {
    return uploaderState.calls;
  },
  get totalChunks() {
    return uploaderState.totalChunks;
  },
  get pctComplete() {
    return Math.round((uploaderState.calls / uploaderState.totalChunks) * 100);
  },
  uploadChunk: vi.fn().mockImplementation(async () => {
    uploaderState.calls++;
  }),
};

function makeMockTxWithTags(tags: Record<string, string>, dataSize = "0") {
  return {
    data_size: dataSize,
    tags: Object.entries(tags).map(([name, value]) => ({
      name,
      value,
      get: (field: string, _opts?: unknown): string =>
        field === "name" ? name : value,
    })),
  };
}

// The default getData response — keeps retrieve tests simple.
const DEFAULT_RETRIEVED_DATA = new TextEncoder().encode("retrieved-data");
// Pre-compute the matching hash so the default transactions.get mock passes verification.
const DEFAULT_CONTENT_HASH = Array.from(blake3(DEFAULT_RETRIEVED_DATA))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

const mockArweave = {
  // createTransaction is a top-level method on the Arweave instance
  createTransaction: vi.fn().mockResolvedValue(mockTx),
  transactions: {
    getPrice: vi.fn().mockResolvedValue("1000000"), // 1 winston
    sign: vi.fn().mockResolvedValue(undefined),
    getUploader: vi.fn().mockResolvedValue(mockUploader),
    getData: vi.fn().mockResolvedValue(DEFAULT_RETRIEVED_DATA),
    getStatus: vi
      .fn()
      .mockResolvedValue({ status: 200, confirmed: { block_height: 1234567 } }),
    get: vi
      .fn()
      .mockResolvedValue(
        makeMockTxWithTags({ "X-Content-Hash": DEFAULT_CONTENT_HASH }),
      ),
  },
  ar: {
    winstonToAr: vi.fn().mockReturnValue("0.000001"),
  },
};

vi.mock("arweave", () => ({
  default: {
    init: vi.fn().mockReturnValue(mockArweave),
  },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

const MOCK_JWK: Record<string, string> = {
  kty: "RSA",
  n: "mock_n",
  e: "AQAB",
};

function nodeAdapter(overrides: Record<string, unknown> = {}) {
  return new ArweaveStorageAdapter({ walletKey: MOCK_JWK, ...overrides });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ArweaveStorageAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset uploader state and restore default mock implementations after clearAllMocks.
    uploaderState = { calls: 0, totalChunks: 1 };
    mockTx.id = TX_MOCK;
    mockArweave.createTransaction.mockResolvedValue(mockTx);
    mockArweave.transactions.getPrice.mockResolvedValue("1000000");
    mockArweave.transactions.sign.mockResolvedValue(undefined);
    mockArweave.transactions.getUploader.mockResolvedValue(mockUploader);
    mockUploader.uploadChunk.mockImplementation(async () => {
      uploaderState.calls++;
    });
    mockArweave.transactions.getData.mockResolvedValue(DEFAULT_RETRIEVED_DATA);
    mockArweave.transactions.getStatus.mockResolvedValue({
      status: 200,
      confirmed: { block_height: 1234567 },
    });
    mockArweave.transactions.get.mockResolvedValue(
      makeMockTxWithTags({ "X-Content-Hash": DEFAULT_CONTENT_HASH }),
    );
    mockArweave.ar.winstonToAr.mockReturnValue("0.000001");
  });

  it("ARWEAVE_MAINNET points to arweave.net:443 over HTTPS", () => {
    expect(ARWEAVE_MAINNET).toEqual({
      host: "arweave.net",
      port: 443,
      protocol: "https",
    });
  });

  // ── identity ────────────────────────────────────────────────────────────────

  it('name is "arweave"', () => {
    expect(nodeAdapter().name).toBe("arweave");
  });

  // ── constructor / config ────────────────────────────────────────────────────

  describe("constructor", () => {
    it("accepts an empty config (browser mode assumed)", () => {
      // Should not throw — browser path is only validated at upload time
      expect(() => new ArweaveStorageAdapter()).not.toThrow();
    });

    it("rejects managedPayment.testMode (only supported by ArweaveLocalStorageAdapter)", () => {
      try {
        new ArweaveStorageAdapter({
          walletKey: MOCK_JWK,
          managedPayment: {
            signingServerUrl: "https://signing.example.com",
            authToken: "tok_test",
            testMode: true,
          },
        });
        expect.unreachable("constructor should have thrown");
      } catch (err) {
        expect((err as { code?: number }).code).toBe(
          StorageErrorCode.ARWEAVE_TEST_MODE_UNSUPPORTED,
        );
        expect((err as Error).message).toMatch(/^\[dStorage\/arweave\]/);
      }
    });

    it("accepts a full config object", () => {
      expect(
        () =>
          new ArweaveStorageAdapter({
            walletKey: MOCK_JWK,
            gateway: { host: "arweave.dev", port: 443, protocol: "https" },
            maxRetries: 5,
            waitForConfirmation: false,
            confirmationPollMs: 10_000,
            confirmationTimeoutMs: 300_000,
          }),
      ).not.toThrow();
    });
  });

  // ── upload ──────────────────────────────────────────────────────────────────

  const enc = (s: string) => new TextEncoder().encode(s);

  describe("upload", () => {
    it("returns an UploadResult with all required fields", async () => {
      const adapter = nodeAdapter();
      const result = await adapter.store(enc("hello arweave"));

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("cost");
      expect(result).toHaveProperty("uploadedAt");
    });

    it('provider is "arweave"', async () => {
      const result = await nodeAdapter().store(enc("data"));
      expect(result.provider).toBe("arweave");
    });

    it("id is the transaction id returned by arweave-js", async () => {
      const result = await nodeAdapter().store(enc("data"));
      expect(result.id).toBe(TX_MOCK);
    });

    it("cost contains the AR amount from the fee oracle", async () => {
      const result = await nodeAdapter().store(enc("data"));
      expect(result.cost).toMatchObject({ token: "AR", amount: "0.000001" });
    });

    it("url is constructed from gateway + txId", async () => {
      const result = await nodeAdapter().store(enc("data"));
      expect(result.url).toBe(`https://arweave.net/${TX_MOCK}`);
    });

    it("url uses testnet gateway when configured", async () => {
      const adapter = nodeAdapter({
        gateway: { host: "arweave.dev", port: 443, protocol: "https" },
      });
      const result = await adapter.store(enc("data"));
      expect(result.url).toContain("arweave.dev");
    });

    it("uploadedAt is a recent timestamp", async () => {
      const before = Date.now();
      const result = await nodeAdapter().store(enc("data"));
      const after = Date.now();
      expect(result.uploadedAt).toBeGreaterThanOrEqual(before);
      expect(result.uploadedAt).toBeLessThanOrEqual(after);
    });

    it("adds caller-supplied metadata as tags", async () => {
      await nodeAdapter().store(enc("data"), {
        "dstorage-owner": "0xABC",
        label: "test",
      });
      expect(mockTx.addTag).toHaveBeenCalledWith("dstorage-owner", "0xABC");
      expect(mockTx.addTag).toHaveBeenCalledWith("label", "test");
    });

    it("signs the transaction before uploading", async () => {
      await nodeAdapter().store(enc("data"));
      const signOrder =
        mockArweave.transactions.sign.mock.invocationCallOrder[0];
      const uploaderOrder =
        mockArweave.transactions.getUploader.mock.invocationCallOrder[0] ?? 0;
      expect(signOrder).toBeLessThan(uploaderOrder);
    });

    it("throws if Node.js walletKey is empty", async () => {
      const adapter = new ArweaveStorageAdapter({ walletKey: {} });
      await expect(adapter.store(enc("data"))).rejects.toMatchObject({
        code: PaymentErrorCode.ARWEAVE_WALLET_KEY_REQUIRED,
        message: expect.stringContaining("walletKey"),
      });
    });

    it("retries a failed chunk and succeeds on second attempt", async () => {
      mockUploader.uploadChunk
        .mockRejectedValueOnce(new Error("Network error"))
        .mockImplementationOnce(async () => {
          uploaderState.calls++;
        });

      const result = await nodeAdapter({ maxRetries: 3 }).store(enc("data"));
      expect(result.id).toBe(TX_MOCK);
      expect(mockUploader.uploadChunk).toHaveBeenCalledTimes(2);
    });

    it("throws after exhausting all chunk retries", async () => {
      mockUploader.uploadChunk.mockRejectedValue(
        new Error("Persistent failure"),
      );

      const adapter = nodeAdapter({ maxRetries: 2 });
      await expect(adapter.store(enc("data"))).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_CHUNK_UPLOAD_FAILED,
        message: expect.stringContaining("failed after 2 attempts"),
      });
      expect(mockUploader.uploadChunk).toHaveBeenCalledTimes(2);
    });
  });

  // ── retrieve ────────────────────────────────────────────────────────────────

  describe("retrieve", () => {
    it("returns the data bytes from arweave-js", async () => {
      const { bytes } = await nodeAdapter().retrieve(TX_MOCK);
      expect(bytes).toEqual(new TextEncoder().encode("retrieved-data"));
    });

    it("throws with viewblock.io link when no data is returned", async () => {
      mockArweave.transactions.getData.mockResolvedValueOnce(null);
      await expect(nodeAdapter().retrieve(TX_UNKNOWN)).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_NO_DATA_RETURNED,
        message: expect.stringContaining("viewblock.io"),
      });
    });

    it("throws ARWEAVE_GET_DATA_FAILED when getData rejects", async () => {
      mockArweave.transactions.getData.mockRejectedValueOnce(
        new Error("data was not found!"),
      );
      await expect(nodeAdapter().retrieve(TX_MOCK)).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_GET_DATA_FAILED,
      });
    });

    it("passes decode:true and string:false to getData", async () => {
      await nodeAdapter().retrieve(TX_BASIC);
      expect(mockArweave.transactions.getData).toHaveBeenCalledWith(TX_BASIC, {
        decode: true,
        string: false,
      });
    });

    it("throws before any network call when the id contains path-traversal characters", async () => {
      const retrieveSpy = vi.spyOn(mockArweave.transactions, "get");
      await expect(
        nodeAdapter().retrieve("../../etc/passwd"),
      ).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_INVALID_TX_ID,
        message: expect.stringContaining("Invalid transaction ID"),
      });
      expect(retrieveSpy).not.toHaveBeenCalled();
    });

    it("throws for an id that is shorter than 43 characters", async () => {
      await expect(nodeAdapter().retrieve("shortId")).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_INVALID_TX_ID,
        message: expect.stringContaining("Invalid transaction ID"),
      });
    });

    it("throws for an id that is longer than 43 characters", async () => {
      await expect(nodeAdapter().retrieve(TX_MOCK + "A")).rejects.toMatchObject(
        {
          code: StorageErrorCode.ARWEAVE_INVALID_TX_ID,
          message: expect.stringContaining("Invalid transaction ID"),
        },
      );
    });
  });

  // ── estimateCost ─────────────────────────────────────────────────────────────

  describe("estimateCost", () => {
    it("returns a StorageQuote with AR amount converted from winstons", async () => {
      const data = enc("some data");
      const quote = await nodeAdapter().estimateCost(data.byteLength);
      expect(quote).toMatchObject({
        token: "AR",
        amount: "0.000001",
        provider: "arweave",
      });
    });

    it("calls getPrice with the byte length", async () => {
      const data = enc("hello");
      await nodeAdapter().estimateCost(data.byteLength);
      expect(mockArweave.transactions.getPrice).toHaveBeenCalledWith(
        data.byteLength,
      );
    });
  });

  // ── waitForConfirmation ───────────────────────────────────────────────────────

  describe("waitForConfirmation", () => {
    it("polls getStatus until confirmed when waitForConfirmation=true", async () => {
      mockArweave.transactions.getStatus
        .mockResolvedValueOnce({ status: 202 }) // pending
        .mockResolvedValueOnce({
          status: 200,
          confirmed: { block_height: 999 },
        }); // confirmed

      const adapter = nodeAdapter({
        waitForConfirmation: true,
        confirmationPollMs: 1, // minimal delay in tests
        confirmationTimeoutMs: 5_000,
      });

      const result = await adapter.store(enc("data"));
      expect(result.id).toBe(TX_MOCK);
      expect(mockArweave.transactions.getStatus).toHaveBeenCalledTimes(2);
    });

    it("throws a timeout error when confirmation never arrives", async () => {
      mockArweave.transactions.getStatus.mockResolvedValue({ status: 202 });

      const adapter = nodeAdapter({
        waitForConfirmation: true,
        confirmationPollMs: 1,
        confirmationTimeoutMs: 10, // expire immediately
      });

      await expect(adapter.store(enc("data"))).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_CONFIRM_TIMEOUT,
        message: expect.stringMatching(/timeout/i),
      });
    }, 10_000);
  });

  // ── content integrity (X-Content-Hash) ───────────────────────────────────────

  function hexOf(data: Uint8Array): string {
    return Array.from(blake3(data))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  describe("content integrity", () => {
    it("upload adds X-Content-Hash tag matching blake3 of the data", async () => {
      const data = enc("integrity test payload");
      await nodeAdapter().store(data);
      expect(mockTx.addTag).toHaveBeenCalledWith("X-Content-Hash", hexOf(data));
    });

    it("retrieve passes when hash tag matches retrieved bytes", async () => {
      const data = enc("retrieved-data");
      mockArweave.transactions.get.mockResolvedValueOnce(
        makeMockTxWithTags({ "X-Content-Hash": hexOf(data) }),
      );
      await expect(nodeAdapter().retrieve(TX_BASIC)).resolves.toBeDefined();
    });

    it("retrieve throws [dStorage/arweave] with 'hash mismatch' when data is tampered", async () => {
      const originalData = enc("original bytes");
      // Gateway serves wrong bytes but the tag still has the original hash
      mockArweave.transactions.getData.mockResolvedValueOnce(
        enc("tampered bytes"),
      );
      mockArweave.transactions.get.mockResolvedValueOnce(
        makeMockTxWithTags({ "X-Content-Hash": hexOf(originalData) }),
      );
      const err = await nodeAdapter()
        .retrieve(TX_TAMPERED)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: StorageErrorCode.CONTENT_HASH_MISMATCH,
        message: expect.stringMatching(/hash mismatch/i),
      });
    });

    it("retrieve throws when X-Content-Hash tag is absent", async () => {
      mockArweave.transactions.get.mockResolvedValueOnce(
        makeMockTxWithTags({}),
      );
      await expect(nodeAdapter().retrieve(TX_NO_HASH)).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_HASH_TAG_MISSING,
        message: expect.stringContaining("[dStorage/arweave]"),
      });
    });

    it("expectedContentHash anchor overrides a colluding gateway's self-consistent (tampered bytes, forged tag) pair", async () => {
      const originalData = enc("original bytes");
      const tamperedData = enc("tampered bytes");
      // Gateway serves tampered bytes AND a tag that matches those tampered
      // bytes — internally consistent, so the gateway-tag-only check would pass.
      mockArweave.transactions.getData.mockResolvedValueOnce(tamperedData);
      mockArweave.transactions.get.mockResolvedValueOnce(
        makeMockTxWithTags({ "X-Content-Hash": hexOf(tamperedData) }),
      );
      const err = await nodeAdapter()
        .retrieve(TX_ANCHOR_OVERRIDE, {
          expectedContentHash: hexOf(originalData),
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: StorageErrorCode.CONTENT_HASH_MISMATCH,
        message: expect.stringMatching(/hash mismatch/i),
      });
    });

    it("expectedContentHash anchor allows retrieve to succeed when the X-Content-Hash tag is absent", async () => {
      const data = enc("retrieved-data");
      mockArweave.transactions.get.mockResolvedValueOnce(
        makeMockTxWithTags({}),
      );
      await expect(
        nodeAdapter().retrieve(TX_ANCHOR_NO_TAG, {
          expectedContentHash: hexOf(data),
        }),
      ).resolves.toBeDefined();
    });

    it("retrieve skips hash verification when skipIntegrityCheck is true", async () => {
      // Return data that would fail the hash check — adapter must not call transactions.get
      mockArweave.transactions.getData.mockResolvedValueOnce(
        enc("tampered bytes"),
      );
      const adapter = nodeAdapter({ skipIntegrityCheck: true });
      await expect(adapter.retrieve(TX_SKIP)).resolves.toBeDefined();
      expect(mockArweave.transactions.get).not.toHaveBeenCalled();
    });

    it("retrieve throws when transactions.get() fails (metadata required for integrity)", async () => {
      mockArweave.transactions.get.mockRejectedValueOnce(
        new Error("tx not indexed yet"),
      );
      await expect(nodeAdapter().retrieve(TX_UNINDEXED)).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_TX_METADATA_FAILED,
        message: expect.stringMatching(
          /Could not fetch transaction metadata.*content hash cannot be verified/,
        ),
      });
    });
  });

  // ── retrieve size limit ───────────────────────────────────────────────────────

  describe("retrieve size limit", () => {
    it("throws when tx data_size exceeds maxRetrieveSizeBytes (pre-download guard)", async () => {
      const limit = 100;
      mockArweave.transactions.get.mockResolvedValueOnce(
        makeMockTxWithTags({ "X-Content-Hash": DEFAULT_CONTENT_HASH }, "9999"),
      );
      const adapter = nodeAdapter({ maxRetrieveSizeBytes: limit });
      await expect(adapter.retrieve(TX_HUGE)).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_TX_TOO_LARGE,
        message: expect.stringMatching(/data_size.*exceeds.*configured limit/),
      });
      // Data was NOT downloaded.
      expect(mockArweave.transactions.getData).not.toHaveBeenCalled();
    });

    it("throws when downloaded bytes exceed maxRetrieveSizeBytes (post-load guard)", async () => {
      // data_size in tx metadata is below the limit so the pre-load guard passes,
      // but getData returns more bytes than the limit — triggering the post-load guard.
      const bigData = new Uint8Array(200);
      mockArweave.transactions.get.mockResolvedValueOnce(
        makeMockTxWithTags({ "X-Content-Hash": hexOf(bigData) }, "50"),
      );
      mockArweave.transactions.getData.mockResolvedValueOnce(bigData);
      const adapter = nodeAdapter({ maxRetrieveSizeBytes: 100 });
      await expect(adapter.retrieve(TX_BIG)).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_SIZE_MISMATCH,
        message: expect.stringMatching(/Downloaded.*exceeds.*configured limit/),
      });
    });

    it("post-load guard applies even when skipIntegrityCheck is true", async () => {
      const bigData = new Uint8Array(200);
      mockArweave.transactions.getData.mockResolvedValueOnce(bigData);
      const adapter = nodeAdapter({
        maxRetrieveSizeBytes: 100,
        skipIntegrityCheck: true,
      });
      await expect(adapter.retrieve(TX_BIG_SKIP)).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_SIZE_MISMATCH,
        message: expect.stringMatching(/Downloaded.*exceeds.*configured limit/),
      });
    });

    it("succeeds when data is within the limit", async () => {
      const adapter = nodeAdapter({ maxRetrieveSizeBytes: 1024 * 1024 });
      await expect(adapter.retrieve(TX_OK)).resolves.toBeDefined();
    });
  });

  // ── browser ArConnect detection ──────────────────────────────────────────────

  describe("browser ArConnect detection", () => {
    it("throws with ArConnect install URL when window.arweaveWallet is missing", async () => {
      // Simulate browser environment (no walletKey, no window.arweaveWallet)
      const adapter = new ArweaveStorageAdapter();

      // Ensure window exists but arweaveWallet is not set
      const win = globalThis as Record<string, unknown>;
      const original = win["window"];
      win["window"] = {}; // simulate bare browser window

      try {
        await expect(adapter.store(enc("data"))).rejects.toMatchObject({
          code: PaymentErrorCode.ARWEAVE_CONNECT_NOT_FOUND,
          message: expect.stringContaining("ArConnect"),
        });
      } finally {
        win["window"] = original;
      }
    });
  });
});
