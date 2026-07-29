import { describe, it, expect, vi, afterEach } from "vitest";
import { MidnightChainAdapter } from "../adapters/midnight/src/midnight.js";
import type { AdapterWalletProvider } from "../adapters/midnight/src/common-types.js";
import { ChainErrorCode } from "../errors.js";

const MOCK_WALLET_PROVIDER = {} as AdapterWalletProvider;
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
      let err: unknown;
      try {
        new MidnightChainAdapter({
          contractAddress: "",
          network: MOCK_NETWORK,
          walletMode: "provider",
          walletProvider: MOCK_WALLET_PROVIDER,
          privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_INVALID_CONTRACT_ADDRESS,
        message: expect.stringContaining(
          "[dStorage/midnight] Invalid contract address",
        ),
      });
    });

    it("throws for contractAddress with wrong format (not 64-char hex)", () => {
      let err: unknown;
      try {
        new MidnightChainAdapter({
          contractAddress: "0xNotHex",
          network: MOCK_NETWORK,
          walletMode: "provider",
          walletProvider: MOCK_WALLET_PROVIDER,
          privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_INVALID_CONTRACT_ADDRESS,
        message: expect.stringContaining(
          "Expected a 64-character lowercase hex string",
        ),
      });
    });

    it("throws if network is not provided (undefined)", () => {
      let err: unknown;
      try {
        // @ts-expect-error — intentional: testing runtime validation
        new MidnightChainAdapter({
          contractAddress: VALID_ADDR,
          walletMode: "provider",
          walletProvider: MOCK_WALLET_PROVIDER,
          privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_NETWORK_REQUIRED,
        message: expect.stringContaining(
          "[dStorage/midnight] network is required",
        ),
      });
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
      let err: unknown;
      try {
        // @ts-expect-error — intentional: testing runtime validation
        new MidnightChainAdapter({
          contractAddress: VALID_ADDR,
          network: MOCK_NETWORK,
          walletMode: "provider",
          privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_WALLET_PROVIDER_REQUIRED,
        message: expect.stringContaining(
          '[dStorage/midnight] walletProvider is required (walletMode: "provider")',
        ),
      });
    });

    it("throws if privateStatePassword is missing", () => {
      let err: unknown;
      try {
        // @ts-expect-error — intentional: testing runtime validation
        new MidnightChainAdapter({
          contractAddress: VALID_ADDR,
          network: MOCK_NETWORK,
          walletMode: "provider",
          walletProvider: MOCK_WALLET_PROVIDER,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_PRIVATE_STATE_PASSWORD_REQUIRED,
        message: expect.stringContaining(
          '[dStorage/midnight] privateStatePassword is required (walletMode: "provider")',
        ),
      });
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

    it("connector mode accepts allowWalletProofServer: true without throwing", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "connector",
            zkConfigBaseUrl: "http://localhost:3000",
            allowWalletProofServer: true,
          }),
      ).not.toThrow();
    });

    it("connector mode defaults allowWalletProofServer to false (no throw)", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "connector",
            zkConfigBaseUrl: "http://localhost:3000",
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
      ).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_NOT_INITIALIZED,
        message: expect.stringContaining("init()"),
      });
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
      ).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_NOT_INITIALIZED,
        message: expect.stringContaining("init()"),
      });
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
      let err: unknown;
      try {
        adapter.setContractAddress("0xNotValid");
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_INVALID_CONTRACT_ADDRESS,
        message: expect.stringContaining(
          "[dStorage/midnight] Invalid contract address",
        ),
      });
    });

    it("throws for an empty address", () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "provider",
        walletProvider: MOCK_WALLET_PROVIDER,
        privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
      });
      let err: unknown;
      try {
        adapter.setContractAddress("");
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_INVALID_CONTRACT_ADDRESS,
        message: expect.stringContaining(
          "[dStorage/midnight] Invalid contract address",
        ),
      });
    });
  });

  // ── _initConnector wallet selection ───────────────────────────────────────

  describe("_initConnector wallet selection", () => {
    type FakeWallet = {
      name?: string;
      rdns?: string;
      apiVersion?: string;
      connect: ReturnType<typeof vi.fn>;
    };

    const FAKE_CONNECTED_API = {
      getConfiguration: vi.fn().mockRejectedValue(new Error("no config")),
      getShieldedAddresses: vi.fn().mockResolvedValue({
        shieldedAddress: "fake-shielded-address",
        shieldedCoinPublicKey: "fake-coin-pk",
        shieldedEncryptionPublicKey: "fake-enc-pk",
      }),
      getUnshieldedAddress: vi
        .fn()
        .mockRejectedValue(new Error("no unshielded address")),
      getDustAddress: vi.fn().mockRejectedValue(new Error("no dust address")),
    };

    function makeFakeWallet(
      opts: { name?: string; rdns?: string } = {},
    ): FakeWallet {
      return {
        ...opts,
        apiVersion: "4.0.0",
        connect: vi.fn().mockResolvedValue(FAKE_CONNECTED_API),
      };
    }

    function makeMockLogger() {
      return {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
    }

    function stubWindowMidnight(wallets: Record<string, FakeWallet>) {
      vi.stubGlobal("window", { midnight: wallets });
    }

    function makeConnectorAdapter(
      connectorName: string | undefined,
      logger: ReturnType<typeof makeMockLogger>,
    ) {
      return new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        proofServerEndpoint: "http://localhost:6300",
        walletMode: "connector",
        ...(connectorName !== undefined ? { connectorName } : {}),
        logger,
      });
    }

    it("selects the wallet whose rdns matches connectorName", async () => {
      const lace = makeFakeWallet({ name: "lace", rdns: "io.lace.wallet" });
      const oneAm = makeFakeWallet({
        name: "1AM",
        rdns: "com.midnight.1am",
      });
      stubWindowMidnight({
        "37e66147-8d22-48f5-94d2-784a7dd8963f": lace,
        "1am": oneAm,
      });
      const logger = makeMockLogger();
      const adapter = makeConnectorAdapter("io.lace.wallet", logger);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any)._initConnector();

      expect(lace.connect).toHaveBeenCalledTimes(1);
      expect(oneAm.connect).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        "dStorage/midnight",
        expect.stringContaining("not found"),
      );
    });

    it("selects the wallet whose name matches connectorName (no rdns match)", async () => {
      const lace = makeFakeWallet({ name: "lace", rdns: "io.lace.wallet" });
      const oneAm = makeFakeWallet({
        name: "1AM",
        rdns: "com.midnight.1am",
      });
      stubWindowMidnight({
        "37e66147-8d22-48f5-94d2-784a7dd8963f": lace,
        "1am": oneAm,
      });
      const logger = makeMockLogger();
      const adapter = makeConnectorAdapter("1AM", logger);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any)._initConnector();

      expect(oneAm.connect).toHaveBeenCalledTimes(1);
      expect(lace.connect).not.toHaveBeenCalled();
    });

    it("selects the wallet whose injected key matches connectorName (no rdns/name match)", async () => {
      const lace = makeFakeWallet({ name: "lace", rdns: "io.lace.wallet" });
      const oneAm = makeFakeWallet({
        name: "1AM",
        rdns: "com.midnight.1am",
      });
      stubWindowMidnight({
        "37e66147-8d22-48f5-94d2-784a7dd8963f": lace,
        "1am": oneAm,
      });
      const logger = makeMockLogger();
      const adapter = makeConnectorAdapter("1am", logger);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any)._initConnector();

      expect(oneAm.connect).toHaveBeenCalledTimes(1);
      expect(lace.connect).not.toHaveBeenCalled();
    });

    it("prefers an rdns match over an id/name match on a different wallet", async () => {
      // Wallet A's id/name equals connectorName, but wallet B's rdns also
      // equals connectorName — the rdns match must win.
      const walletA = makeFakeWallet({ name: "io.lace.wallet" });
      const walletB = makeFakeWallet({ rdns: "io.lace.wallet" });
      stubWindowMidnight({
        "io.lace.wallet": walletA,
        "some-other-key": walletB,
      });
      const logger = makeMockLogger();
      const adapter = makeConnectorAdapter("io.lace.wallet", logger);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any)._initConnector();

      expect(walletB.connect).toHaveBeenCalledTimes(1);
      expect(walletA.connect).not.toHaveBeenCalled();
    });

    it("falls back to the first wallet and warns when connectorName matches nothing", async () => {
      const lace = makeFakeWallet({ name: "lace", rdns: "io.lace.wallet" });
      const oneAm = makeFakeWallet({
        name: "1AM",
        rdns: "com.midnight.1am",
      });
      stubWindowMidnight({
        "37e66147-8d22-48f5-94d2-784a7dd8963f": lace,
        "1am": oneAm,
      });
      const logger = makeMockLogger();
      const adapter = makeConnectorAdapter("nonexistent-wallet", logger);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any)._initConnector();

      expect(lace.connect).toHaveBeenCalledTimes(1);
      expect(oneAm.connect).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "dStorage/midnight",
        expect.stringContaining(
          'Configured wallet "nonexistent-wallet" not found',
        ),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "dStorage/midnight",
        expect.stringContaining("Using first available"),
      );
    });

    it("uses the first discovered wallet when connectorName is not set", async () => {
      const lace = makeFakeWallet({ name: "lace", rdns: "io.lace.wallet" });
      const oneAm = makeFakeWallet({
        name: "1AM",
        rdns: "com.midnight.1am",
      });
      stubWindowMidnight({
        "37e66147-8d22-48f5-94d2-784a7dd8963f": lace,
        "1am": oneAm,
      });
      const logger = makeMockLogger();
      const adapter = makeConnectorAdapter(undefined, logger);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any)._initConnector();

      expect(lace.connect).toHaveBeenCalledTimes(1);
      expect(oneAm.connect).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        "dStorage/midnight",
        expect.stringContaining("not found"),
      );
    });

    it("throws MIDNIGHT_WALLET_NOT_FOUND when window.midnight is absent", async () => {
      vi.stubGlobal("window", {});
      const logger = makeMockLogger();
      const adapter = makeConnectorAdapter(undefined, logger);

      let err: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._initConnector();
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_WALLET_NOT_FOUND,
      });
    });

    it("throws MIDNIGHT_NO_WALLETS_FOUND when window.midnight has no connect-shaped entries", async () => {
      vi.stubGlobal("window", { midnight: { notAWallet: {} } });
      const logger = makeMockLogger();
      const adapter = makeConnectorAdapter(undefined, logger);

      let err: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (adapter as any)._initConnector();
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_NO_WALLETS_FOUND,
      });
    });
  });
});
