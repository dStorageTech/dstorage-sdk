/**
 * ArweaveStorageAdapter tests
 *
 * All tests run without real network calls — arweave-js is mocked at the
 * module level so the suite is fast, offline, and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArweaveStorageAdapter } from "../adapters/arweave.js";

// ── arweave-js mock ───────────────────────────────────────────────────────────

const mockTx = {
  id: "mock_tx_id_abc123",
  addTag: vi.fn(),
  data: "",
};

const mockArweave = {
  // createTransaction is a top-level method on the Arweave instance
  createTransaction: vi.fn().mockResolvedValue(mockTx),
  transactions: {
    getPrice: vi.fn().mockResolvedValue("1000000"), // 1 winston
    sign: vi.fn().mockResolvedValue(undefined),
    post: vi.fn().mockResolvedValue({ status: 200, statusText: "OK" }),
    getData: vi.fn().mockResolvedValue(new TextEncoder().encode("retrieved-data")),
    getStatus: vi
      .fn()
      .mockResolvedValue({ status: 200, confirmed: { block_height: 1234567 } }),
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
    // Reset mockTx id and restore default mock implementations after clearAllMocks
    mockTx.id = "mock_tx_id_abc123";
    mockArweave.createTransaction.mockResolvedValue(mockTx);
    mockArweave.transactions.getPrice.mockResolvedValue("1000000");
    mockArweave.transactions.sign.mockResolvedValue(undefined);
    mockArweave.transactions.post.mockResolvedValue({
      status: 200,
      statusText: "OK",
    });
    mockArweave.transactions.getData.mockResolvedValue(new TextEncoder().encode("retrieved-data"));
    mockArweave.transactions.getStatus.mockResolvedValue({
      status: 200,
      confirmed: { block_height: 1234567 },
    });
    mockArweave.ar.winstonToAr.mockReturnValue("0.000001");
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
      const result = await adapter.upload(enc("hello arweave"));

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("cost");
      expect(result).toHaveProperty("uploadedAt");
    });

    it('provider is "arweave"', async () => {
      const result = await nodeAdapter().upload(enc("data"));
      expect(result.provider).toBe("arweave");
    });

    it("id is the transaction id returned by arweave-js", async () => {
      const result = await nodeAdapter().upload(enc("data"));
      expect(result.id).toBe("mock_tx_id_abc123");
    });

    it("cost contains the AR amount from the fee oracle", async () => {
      const result = await nodeAdapter().upload(enc("data"));
      expect(result.cost).toContain("AR");
      expect(result.cost).toContain("0.000001");
    });

    it("url is constructed from gateway + txId", async () => {
      const result = await nodeAdapter().upload(enc("data"));
      expect(result.url).toBe("https://arweave.net/mock_tx_id_abc123");
    });

    it("url uses testnet gateway when configured", async () => {
      const adapter = nodeAdapter({
        gateway: { host: "arweave.dev", port: 443, protocol: "https" },
      });
      const result = await adapter.upload(enc("data"));
      expect(result.url).toContain("arweave.dev");
    });

    it("uploadedAt is a recent timestamp", async () => {
      const before = Date.now();
      const result = await nodeAdapter().upload(enc("data"));
      const after = Date.now();
      expect(result.uploadedAt).toBeGreaterThanOrEqual(before);
      expect(result.uploadedAt).toBeLessThanOrEqual(after);
    });

    it("adds standard dStorage tags to the transaction", async () => {
      await nodeAdapter().upload(enc("data"));
      expect(mockTx.addTag).toHaveBeenCalledWith("App-Name", "dStorage");
      expect(mockTx.addTag).toHaveBeenCalledWith("App-Version", "0.1.0");
      expect(mockTx.addTag).toHaveBeenCalledWith(
        "Content-Type",
        "application/octet-stream",
      );
    });

    it("adds caller-supplied metadata as tags", async () => {
      await nodeAdapter().upload(enc("data"), {
        "dstorage-owner": "0xABC",
        label: "test",
      });
      expect(mockTx.addTag).toHaveBeenCalledWith("dstorage-owner", "0xABC");
      expect(mockTx.addTag).toHaveBeenCalledWith("label", "test");
    });

    it("signs the transaction before posting", async () => {
      await nodeAdapter().upload(enc("data"));
      const signOrder =
        mockArweave.transactions.sign.mock.invocationCallOrder[0];
      const postOrder =
        mockArweave.transactions.post.mock.invocationCallOrder[0];
      expect(signOrder).toBeLessThan(postOrder);
    });

    it("throws if Node.js walletKey is empty", async () => {
      const adapter = new ArweaveStorageAdapter({ walletKey: {} });
      await expect(adapter.upload(enc("data"))).rejects.toThrow(/walletKey/);
    });

    it("retries on HTTP 500 and succeeds on second attempt", async () => {
      mockArweave.transactions.post
        .mockResolvedValueOnce({ status: 500, statusText: "Server Error" })
        .mockResolvedValueOnce({ status: 200, statusText: "OK" });

      const result = await nodeAdapter({ maxRetries: 3 }).upload(enc("data"));
      expect(result.id).toBe("mock_tx_id_abc123");
      expect(mockArweave.transactions.post).toHaveBeenCalledTimes(2);
    });

    it("throws after exhausting all retries", async () => {
      mockArweave.transactions.post.mockResolvedValue({
        status: 500,
        statusText: "Server Error",
      });

      const adapter = nodeAdapter({ maxRetries: 2 });
      await expect(adapter.upload(enc("data"))).rejects.toThrow(/HTTP 500/);
      expect(mockArweave.transactions.post).toHaveBeenCalledTimes(2);
    });
  });

  // ── retrieve ────────────────────────────────────────────────────────────────

  describe("retrieve", () => {
    it("returns the data bytes from arweave-js", async () => {
      const result = await nodeAdapter().retrieve("mock_tx_id_abc123");
      expect(result).toEqual(new TextEncoder().encode("retrieved-data"));
    });

    it("throws with viewblock.io link when no data is returned", async () => {
      mockArweave.transactions.getData.mockResolvedValueOnce(null);
      await expect(nodeAdapter().retrieve("unknown_tx")).rejects.toThrow(
        /viewblock\.io/,
      );
    });

    it("passes decode:true and string:false to getData", async () => {
      await nodeAdapter().retrieve("tx_123");
      expect(mockArweave.transactions.getData).toHaveBeenCalledWith("tx_123", {
        decode: true,
        string: false,
      });
    });
  });

  // ── estimateCost ─────────────────────────────────────────────────────────────

  describe("estimateCost", () => {
    it("returns the raw winstons value from getPrice", async () => {
      const cost = await nodeAdapter().estimateCost(enc("some data"));
      expect(cost).toBe("1000000");
    });

    it("calls getPrice with the byte length of the data", async () => {
      const data = enc("hello");
      await nodeAdapter().estimateCost(data);
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

      const result = await adapter.upload(enc("data"));
      expect(result.id).toBe("mock_tx_id_abc123");
      expect(mockArweave.transactions.getStatus).toHaveBeenCalledTimes(2);
    });

    it("throws a timeout error when confirmation never arrives", async () => {
      mockArweave.transactions.getStatus.mockResolvedValue({ status: 202 });

      const adapter = nodeAdapter({
        waitForConfirmation: true,
        confirmationPollMs: 1,
        confirmationTimeoutMs: 10, // expire immediately
      });

      await expect(adapter.upload(enc("data"))).rejects.toThrow(/timeout/i);
    }, 10_000);
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
        await expect(adapter.upload(enc("data"))).rejects.toThrow(/ArConnect/);
      } finally {
        win["window"] = original;
      }
    });
  });
});
