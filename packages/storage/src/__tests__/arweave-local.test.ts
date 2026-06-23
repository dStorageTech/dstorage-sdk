/**
 * ArweaveLocalStorageAdapter + ArweaveLocalHelper tests
 *
 * All tests are offline — arlocal's HTTP API and arweave-js are fully mocked.
 * No arlocal server or real network connection is required to run these tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  ArweaveLocalStorageAdapter,
  ArweaveLocalHelper,
  ArweaveLocalError,
  ARWEAVE_LOCAL,
  arlocalGateway,
} from "../adapters/arweave-local.js";
import { StorageErrorCode } from "../errors.js";

// ── arweave-js mock ───────────────────────────────────────────────────────────

const MOCK_JWK: Record<string, string> = { kty: "RSA", n: "mock_n", e: "AQAB" };
const MOCK_ADDRESS = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOCK_TX_ID = "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";

const MOCK_RETRIEVED_DATA = new TextEncoder().encode("test-retrieved-data");
const MOCK_CONTENT_HASH = Array.from(blake3(MOCK_RETRIEVED_DATA))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

function makeMockTxWithTags(tags: Record<string, string>) {
  return {
    data_size: "0",
    tags: Object.entries(tags).map(([name, value]) => ({
      name,
      value,
      get: (field: string, _opts?: unknown): string =>
        field === "name" ? name : value,
    })),
  };
}

const mockTx = { id: MOCK_TX_ID, addTag: vi.fn() };

let localUploaderState = { calls: 0 };

const mockLocalUploader = {
  get isComplete() {
    return localUploaderState.calls >= 1;
  },
  uploadedChunks: 0,
  totalChunks: 1,
  pctComplete: 100,
  uploadChunk: vi.fn().mockImplementation(async () => {
    localUploaderState.calls++;
  }),
};

const mockArweaveInstance = {
  createTransaction: vi.fn().mockResolvedValue(mockTx),
  wallets: {
    generate: vi.fn().mockResolvedValue(MOCK_JWK),
    jwkToAddress: vi.fn().mockResolvedValue(MOCK_ADDRESS),
  },
  transactions: {
    getPrice: vi.fn().mockResolvedValue("500000"),
    sign: vi.fn().mockResolvedValue(undefined),
    getUploader: vi.fn().mockResolvedValue(mockLocalUploader),
    getData: vi.fn().mockResolvedValue(MOCK_RETRIEVED_DATA),
    get: vi
      .fn()
      .mockResolvedValue(
        makeMockTxWithTags({ "X-Content-Hash": MOCK_CONTENT_HASH }),
      ),
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
  localUploaderState = { calls: 0 };
  mockTx.id = MOCK_TX_ID;
  mockArweaveInstance.createTransaction.mockResolvedValue(mockTx);
  mockArweaveInstance.transactions.getPrice.mockResolvedValue("500000");
  mockArweaveInstance.transactions.sign.mockResolvedValue(undefined);
  mockArweaveInstance.transactions.getUploader.mockResolvedValue(
    mockLocalUploader,
  );
  mockLocalUploader.uploadChunk.mockImplementation(async () => {
    localUploaderState.calls++;
  });
  mockArweaveInstance.transactions.getData.mockResolvedValue(
    MOCK_RETRIEVED_DATA,
  );
  mockArweaveInstance.transactions.get.mockResolvedValue(
    makeMockTxWithTags({ "X-Content-Hash": MOCK_CONTENT_HASH }),
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

    // ── Security: address format validation ──────────────────────────────────
    //
    // A valid Arweave address is always exactly 43 base64url characters
    // ([A-Za-z0-9_-]). Accepting arbitrary strings allows a caller to mint
    // funds to a non-existent or attacker-controlled address, or to construct
    // unexpected URL paths if encodeURIComponent is ever removed.
    // These checks must throw before making any HTTP request.

    it("throws when address is too short (42 chars)", async () => {
      await expect(helper.mintTokens("a".repeat(42))).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_LOCAL_INVALID_ADDRESS,
        message: expect.stringMatching(/address/i),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when address is too long (44 chars)", async () => {
      await expect(helper.mintTokens("a".repeat(44))).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_LOCAL_INVALID_ADDRESS,
        message: expect.stringMatching(/address/i),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when address is empty", async () => {
      await expect(helper.mintTokens("")).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_LOCAL_INVALID_ADDRESS,
        message: expect.stringMatching(/address/i),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when address contains characters outside base64url alphabet", async () => {
      const invalid = "aaa!aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 43 chars but with !
      await expect(helper.mintTokens(invalid)).rejects.toMatchObject({
        code: StorageErrorCode.ARWEAVE_LOCAL_INVALID_ADDRESS,
        message: expect.stringMatching(/address/i),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("accepts a valid 43-char base64url address", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());
      await expect(helper.mintTokens(MOCK_ADDRESS)).resolves.toBeUndefined();
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
      // mine() inside store() calls fetch("/mine") — provide a mock response
      mockFetch.mockResolvedValue(okResponse());
    });

    const enc = (s: string) => new TextEncoder().encode(s);

    it("returns an UploadResult with all required fields", async () => {
      const result = await makeAdapter().store(enc("local test data"));
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("provider", "arweave");
      expect(result).toHaveProperty("cost");
      expect(result).toHaveProperty("uploadedAt");
    });

    it("url contains localhost (testnet gateway)", async () => {
      const result = await makeAdapter().store(enc("data"));
      expect(result.url).toContain("localhost");
    });

    it("tx id matches the mocked transaction id", async () => {
      const result = await makeAdapter().store(enc("data"));
      expect(result.id).toBe(MOCK_TX_ID);
    });
  });

  // ── retrieve ───────────────────────────────────────────────────────────────

  describe("retrieve", () => {
    it("returns the data bytes for a known txId", async () => {
      const { bytes } = await makeAdapter().retrieve(MOCK_TX_ID);
      expect(bytes).toEqual(MOCK_RETRIEVED_DATA);
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
      const result = await adapter.store(
        new TextEncoder().encode("factory test"),
      );
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
