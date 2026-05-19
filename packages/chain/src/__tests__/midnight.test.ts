import { describe, it, expect, vi, afterEach } from "vitest";
import { MidnightChainAdapter } from "../adapters/midnight/src/midnight.js";

const MOCK_WALLET_PROVIDER = { wallet: {} } as any;
const MOCK_PRIVATE_STATE_PASSWORD = "Aa1!mockseedfortest";
const MOCK_NETWORK = "undeployed" as const;

// Valid Midnight contract addresses: 64 lowercase hex chars (32 bytes).
const VALID_ADDR = "a".repeat(64);
const VALID_ADDR_2 = "b".repeat(64);

describe("MidnightChainAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Constructor validation ─────────────────────────────────────────────────

  describe("constructor", () => {
    it('name is "midnight"', () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "provider",
        walletProvider: MOCK_WALLET_PROVIDER,
        privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
      });
      expect(adapter.name).toBe("midnight");
    });

    it("throws for empty contractAddress", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: "",
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
          }),
      ).toThrow("[dStorage/midnight] Invalid contract address");
    });

    it("throws for contractAddress with wrong format (not 64-char hex)", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: "0xNotHex",
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
          }),
      ).toThrow("Expected a 64-character lowercase hex string");
    });

    it("throws if network is not provided (undefined)", () => {
      expect(
        // @ts-expect-error — intentional: testing runtime validation
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
          }),
      ).toThrow("[dStorage/midnight] network is required");
    });

    it("does not throw when credentials are missing in connector mode", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "connector",
          }),
      ).not.toThrow();
    });

    it("does not throw with valid contractAddress in provider mode", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
          }),
      ).not.toThrow();
    });

    it("does not throw with valid contractAddress in connector mode", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "connector",
          }),
      ).not.toThrow();
    });

    it("does not throw when contractAddress is omitted (auto-deploy mode)", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
          }),
      ).not.toThrow();
    });
  });

  // ── Provider mode validation ──────────────────────────────────────────────

  describe('walletMode: "provider"', () => {
    it("throws if walletProvider is missing", () => {
      expect(
        // @ts-expect-error — intentional: testing runtime validation
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
          }),
      ).toThrow(
        '[dStorage/midnight] walletProvider is required (walletMode: "provider")',
      );
    });

    it("throws if privateStatePassword is missing", () => {
      expect(
        // @ts-expect-error — intentional: testing runtime validation
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
          }),
      ).toThrow(
        '[dStorage/midnight] privateStatePassword is required (walletMode: "provider")',
      );
    });
  });

  // ── Default config values ─────────────────────────────────────────────────

  describe("default endpoints", () => {
    it("accepts custom nodeEndpoint", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
            nodeEndpoint: "https://custom.node.example.com",
          }),
      ).not.toThrow();
    });

    it("accepts custom indexerEndpoint", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
            indexerEndpoint: "https://custom.indexer.example.com/graphql",
          }),
      ).not.toThrow();
    });

    it("accepts custom proofServerEndpoint", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
            proofServerEndpoint: "http://proof-server.internal:6300",
          }),
      ).not.toThrow();
    });
  });

  // ── Runtime behaviour when wallet is not initialized ─────────────────────

  describe("runtime behaviour when wallet is not initialized", () => {
    it("writeReference throws about wallet not initialized (provider mode)", async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "provider",
        walletProvider: MOCK_WALLET_PROVIDER,
        privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
      });
      await expect(
        adapter.writeReference({
          storageId: "sid",
          storageProvider: "mock",
          owner: "0xOwner",
          writtenAt: Date.now(),
        }),
      ).rejects.toThrow("init()");
    });

    it("writeReference throws about wallet not initialized (connector mode)", async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "connector",
        zkConfigBaseUrl: "http://localhost:3000",
      });
      await expect(
        adapter.writeReference({
          storageId: "sid",
          storageProvider: "mock",
          owner: "0xOwner",
          writtenAt: Date.now(),
        }),
      ).rejects.toThrow("init()");
    });
  });

  // ── setContractAddress ────────────────────────────────────────────────────

  describe("setContractAddress", () => {
    it("accepts a valid new contract address without throwing", () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "provider",
        walletProvider: MOCK_WALLET_PROVIDER,
        privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
      });
      expect(() => adapter.setContractAddress(VALID_ADDR_2)).not.toThrow();
    });

    it("throws for an invalid format address", () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "provider",
        walletProvider: MOCK_WALLET_PROVIDER,
        privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
      });
      expect(() => adapter.setContractAddress("0xNotValid")).toThrow(
        "[dStorage/midnight] Invalid contract address",
      );
    });

    it("throws for an empty address", () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "provider",
        walletProvider: MOCK_WALLET_PROVIDER,
        privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
      });
      expect(() => adapter.setContractAddress("")).toThrow(
        "[dStorage/midnight] Invalid contract address",
      );
    });
  });
});
