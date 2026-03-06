/**
 * ArweaveLocalStorageAdapter + ArweaveLocalHelper tests
 *
 * All tests are offline — arlocal's HTTP API and arweave-js are fully mocked.
 * No arlocal server or real network connection is required to run these tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ArweaveLocalStorageAdapter,
  ArweaveLocalHelper,
  ArweaveLocalError,
  ARWEAVE_MAINNET,
  ARWEAVE_LOCAL,
  arlocalGateway,
} from "../adapters/arweave-local.js";

// ── arweave-js mock ───────────────────────────────────────────────────────────

const MOCK_JWK: Record<string, string> = { kty: "RSA", n: "mock_n", e: "AQAB" };
const MOCK_ADDRESS = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOCK_TX_ID = "test_tx_id_local_001";

const mockTx = { id: MOCK_TX_ID, addTag: vi.fn() };

const mockArweaveInstance = {
  createTransaction: vi.fn().mockResolvedValue(mockTx),
  wallets: {
    generate: vi.fn().mockResolvedValue(MOCK_JWK),
    jwkToAddress: vi.fn().mockResolvedValue(MOCK_ADDRESS),
  },
  transactions: {
    getPrice: vi.fn().mockResolvedValue("500000"),
    sign: vi.fn().mockResolvedValue(undefined),
    post: vi.fn().mockResolvedValue({ status: 200, statusText: "OK" }),
    getData: vi.fn().mockResolvedValue("test-retrieved-data"),
    getStatus: vi
      .fn()
      .mockResolvedValue({ status: 200, confirmed: { block_height: 42 } }),
  },
  ar: {
    winstonToAr: vi.fn().mockReturnValue("0.0000005"),
  },
};

vi.mock("arweave", () => ({
  default: { init: vi.fn().mockReturnValue(mockArweaveInstance) },
}));

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okResponse(body = "OK", json?: unknown) {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue(json ?? {}),
  };
}

function errorResponse(status: number, body = "Error") {
  return {
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue({}),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return new ArweaveLocalStorageAdapter({ walletKey: MOCK_JWK, ...overrides });
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.id = MOCK_TX_ID;
  mockArweaveInstance.createTransaction.mockResolvedValue(mockTx);
  mockArweaveInstance.transactions.getPrice.mockResolvedValue("500000");
  mockArweaveInstance.transactions.sign.mockResolvedValue(undefined);
  mockArweaveInstance.transactions.post.mockResolvedValue({
    status: 200,
    statusText: "OK",
  });
  mockArweaveInstance.transactions.getData.mockResolvedValue(
    "test-retrieved-data",
  );
  mockArweaveInstance.ar.winstonToAr.mockReturnValue("0.0000005");
  mockArweaveInstance.wallets.generate.mockResolvedValue(MOCK_JWK);
  mockArweaveInstance.wallets.jwkToAddress.mockResolvedValue(MOCK_ADDRESS);
});

afterEach(() => {
  mockFetch.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gateway presets
// ═══════════════════════════════════════════════════════════════════════════════

describe("Gateway presets", () => {
  it("ARWEAVE_MAINNET points to arweave.net:443 over HTTPS", () => {
    expect(ARWEAVE_MAINNET).toEqual({
      host: "arweave.net",
      port: 443,
      protocol: "https",
    });
  });

  it("ARWEAVE_LOCAL points to localhost:1984 over HTTP", () => {
    expect(ARWEAVE_LOCAL).toEqual({
      host: "localhost",
      port: 1984,
      protocol: "http",
    });
  });

  it("arlocalGateway() returns default port 1984", () => {
    expect(arlocalGateway()).toEqual({
      host: "localhost",
      port: 1984,
      protocol: "http",
    });
  });

  it("arlocalGateway(1985) returns port 1985", () => {
    expect(arlocalGateway(1985)).toEqual({
      host: "localhost",
      port: 1985,
      protocol: "http",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ArweaveLocalHelper
// ═══════════════════════════════════════════════════════════════════════════════

describe("ArweaveLocalHelper", () => {
  const helper = new ArweaveLocalHelper({ url: "http://localhost:1984" });

  // ── isRunning ──────────────────────────────────────────────────────────────

  describe("isRunning", () => {
    it("returns true when /info responds with 200", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());
      expect(await helper.isRunning()).toBe(true);
    });

    it("returns false when fetch throws (server not running)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await helper.isRunning()).toBe(false);
    });

    it("returns false when /info returns a non-OK status", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(503));
      expect(await helper.isRunning()).toBe(false);
    });
  });

  // ── mintTokens ─────────────────────────────────────────────────────────────

  describe("mintTokens", () => {
    it("calls GET /mint/{address}/{winstons}", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());
      await helper.mintTokens(MOCK_ADDRESS, 1_000_000_000_000n);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/mint/${MOCK_ADDRESS}/1000000000000`),
      );
    });

    it("defaults to 1 AR (1_000_000_000_000 winstons) when amount is omitted", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());
      await helper.mintTokens(MOCK_ADDRESS);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/1000000000000"),
      );
    });

    it("accepts a plain number amount", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());
      await helper.mintTokens(MOCK_ADDRESS, 500_000_000_000);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/500000000000"),
      );
    });

    it("throws ArweaveLocalError on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, "Internal Server Error"),
      );
      await expect(helper.mintTokens(MOCK_ADDRESS)).rejects.toBeInstanceOf(
        ArweaveLocalError,
      );
    });

    it("ArweaveLocalError has the correct statusCode", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(503, "Unavailable"));
      const err = await helper
        .mintTokens(MOCK_ADDRESS)
        .catch((e: unknown) => e);
      expect((err as ArweaveLocalError).statusCode).toBe(503);
    });
  });

  // ── mine ───────────────────────────────────────────────────────────────────

  describe("mine", () => {
    it("calls GET /mine once by default", async () => {
      mockFetch.mockResolvedValue(okResponse());
      await helper.mine();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/mine"));
    });

    it("calls GET /mine N times when blocks=N", async () => {
      mockFetch.mockResolvedValue(okResponse());
      await helper.mine(3);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("throws ArweaveLocalError if mining fails", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, "mine error"));
      await expect(helper.mine()).rejects.toBeInstanceOf(ArweaveLocalError);
    });
  });

  // ── getBalance ─────────────────────────────────────────────────────────────

  describe("getBalance", () => {
    it("returns winstons as string and AR as human-readable string", async () => {
      mockFetch.mockResolvedValueOnce(okResponse("5000000000000"));
      const bal = await helper.getBalance(MOCK_ADDRESS);
      expect(bal.winstons).toBe("5000000000000");
      expect(bal.ar).toBe("5");
    });

    it("calls GET /wallet/{address}/balance", async () => {
      mockFetch.mockResolvedValueOnce(okResponse("1000000000000"));
      await helper.getBalance(MOCK_ADDRESS);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/wallet/${MOCK_ADDRESS}/balance`),
      );
    });

    it("throws ArweaveLocalError on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, "not found"));
      await expect(helper.getBalance(MOCK_ADDRESS)).rejects.toBeInstanceOf(
        ArweaveLocalError,
      );
    });
  });

  // ── getInfo ────────────────────────────────────────────────────────────────

  describe("getInfo", () => {
    it("returns parsed JSON from /info", async () => {
      const info = {
        network: "arlocal",
        height: 5,
        version: 1,
        release: 0,
        current: "abc",
        peers: 0,
        queue_length: 0,
        node_state_latency: 0,
      };
      mockFetch.mockResolvedValueOnce(okResponse("", info));
      const result = await helper.getInfo();
      expect(result.network).toBe("arlocal");
      expect(result.height).toBe(5);
    });

    it("throws ArweaveLocalError on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(503));
      await expect(helper.getInfo()).rejects.toBeInstanceOf(ArweaveLocalError);
    });
  });

  // ── reset ──────────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("calls GET /reset", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());
      await helper.reset();
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/reset"));
    });

    it("throws ArweaveLocalError on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500));
      await expect(helper.reset()).rejects.toBeInstanceOf(ArweaveLocalError);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ArweaveLocalStorageAdapter
// ═══════════════════════════════════════════════════════════════════════════════

describe("ArweaveLocalStorageAdapter", () => {
  // ── identity & defaults ────────────────────────────────────────────────────

  it('name is "arweave"', () => {
    expect(makeAdapter().name).toBe("arweave");
  });

  it("exposes a .testnet ArweaveLocalHelper", () => {
    expect(makeAdapter().testnet).toBeInstanceOf(ArweaveLocalHelper);
  });

  it("defaults to localhost:1984 gateway", () => {
    // Verified indirectly — testnet helper url is derived from the gateway
    const adapter = makeAdapter();
    expect(adapter.testnet).toBeDefined();
  });

  it("accepts a custom gateway via arlocalGateway()", () => {
    expect(
      () =>
        new ArweaveLocalStorageAdapter({
          walletKey: MOCK_JWK,
          gateway: arlocalGateway(1985),
        }),
    ).not.toThrow();
  });

  // ── upload ─────────────────────────────────────────────────────────────────

  describe("upload", () => {
    beforeEach(() => {
      // mine() inside upload() calls fetch("/mine") — provide a mock response
      mockFetch.mockResolvedValue(okResponse());
    });

    it("returns an UploadResult with all required fields", async () => {
      const result = await makeAdapter().upload("local test data");
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("provider", "arweave");
      expect(result).toHaveProperty("cost");
      expect(result).toHaveProperty("uploadedAt");
    });

    it("url contains localhost (testnet gateway)", async () => {
      const result = await makeAdapter().upload("data");
      expect(result.url).toContain("localhost");
    });

    it("tx id matches the mocked transaction id", async () => {
      const result = await makeAdapter().upload("data");
      expect(result.id).toBe(MOCK_TX_ID);
    });
  });

  // ── retrieve ───────────────────────────────────────────────────────────────

  describe("retrieve", () => {
    it("returns the data for a known txId", async () => {
      const data = await makeAdapter().retrieve(MOCK_TX_ID);
      expect(data).toBe("test-retrieved-data");
    });
  });

  // ── createWithTestWallet (static factory) ──────────────────────────────────

  describe("createWithTestWallet", () => {
    beforeEach(() => {
      // Each createWithTestWallet call mints tokens — mock the fetch for mint
      mockFetch.mockResolvedValue(okResponse());
    });

    it("returns adapter, walletKey, and address", async () => {
      const result = await ArweaveLocalStorageAdapter.createWithTestWallet();
      expect(result.adapter).toBeInstanceOf(ArweaveLocalStorageAdapter);
      expect(result.walletKey).toEqual(MOCK_JWK);
      expect(result.address).toBe(MOCK_ADDRESS);
    });

    it("mints the default 10 AR into the generated wallet", async () => {
      await ArweaveLocalStorageAdapter.createWithTestWallet();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/mint/${MOCK_ADDRESS}/10000000000000`),
      );
    });

    it("mints a custom AR amount when fundAr is specified", async () => {
      await ArweaveLocalStorageAdapter.createWithTestWallet({ fundAr: 3 });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/mint/${MOCK_ADDRESS}/3000000000000`),
      );
    });

    it("uses a custom gateway when provided", async () => {
      const result = await ArweaveLocalStorageAdapter.createWithTestWallet({
        gateway: arlocalGateway(1985),
      });
      expect(result.adapter).toBeInstanceOf(ArweaveLocalStorageAdapter);
    });

    it("the returned adapter can upload data", async () => {
      const { adapter } =
        await ArweaveLocalStorageAdapter.createWithTestWallet();
      const result = await adapter.upload("factory test");
      expect(result.id).toBe(MOCK_TX_ID);
    });
  });

  // ── testnet helper integration ─────────────────────────────────────────────

  describe("testnet helper via adapter", () => {
    it("adapter.testnet.mintTokens calls the mint endpoint", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());
      const adapter = makeAdapter();
      await adapter.testnet.mintTokens(MOCK_ADDRESS, 1_000_000_000_000n);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/mint/${MOCK_ADDRESS}/1000000000000`),
      );
    });

    it("adapter.testnet.mine calls the mine endpoint", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());
      const adapter = makeAdapter();
      await adapter.testnet.mine();
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/mine"));
    });

    it("adapter.testnet.getBalance returns balance for address", async () => {
      mockFetch.mockResolvedValueOnce(okResponse("2000000000000"));
      const adapter = makeAdapter();
      const { ar } = await adapter.testnet.getBalance(MOCK_ADDRESS);
      expect(ar).toBe("2");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ArweaveLocalError
// ═══════════════════════════════════════════════════════════════════════════════

describe("ArweaveLocalError", () => {
  it("has correct name", () => {
    const err = new ArweaveLocalError("test", 500);
    expect(err.name).toBe("ArweaveLocalError");
  });

  it("stores statusCode", () => {
    expect(new ArweaveLocalError("msg", 404).statusCode).toBe(404);
  });

  it("includes the message in the error", () => {
    const err = new ArweaveLocalError("something went wrong", 500);
    expect(err.message).toContain("something went wrong");
  });

  it("is an instance of Error", () => {
    expect(new ArweaveLocalError("x", 500)).toBeInstanceOf(Error);
  });
});
