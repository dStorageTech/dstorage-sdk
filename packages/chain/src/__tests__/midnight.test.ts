import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MidnightChainAdapter,
  PROVER_MODE,
} from "../adapters/midnight/src/midnight.js";
import type { AdapterWalletProvider } from "../adapters/midnight/src/common-types.js";
import { ChainErrorCode } from "../errors.js";
import { createProofProvider } from "@midnight-ntwrk/midnight-js-types";

// Stand-in for the ledger's unprovenTx.prove(): proveTx hands the ProvingProvider
// to the "transaction", so tests can drive check/prove without real circuits.
vi.mock("@midnight-ntwrk/midnight-js-types", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@midnight-ntwrk/midnight-js-types")
  >()),
  createProofProvider: vi.fn((provingProvider: unknown) => ({
    proveTx: (tx: { prove: (p: unknown) => Promise<unknown> }) =>
      tx.prove(provingProvider),
  })),
}));

type TestProvingProvider = {
  check: (p: Uint8Array, k: string) => Promise<unknown>;
  prove: (p: Uint8Array, k: string, b?: bigint) => Promise<Uint8Array>;
};

/** The (wrapped) ProvingProvider most recently passed to createProofProvider. */
function lastProvingProvider(): TestProvingProvider {
  return vi.mocked(createProofProvider).mock
    .lastCall![0] as TestProvingProvider;
}

const MOCK_WALLET_PROVIDER = {} as AdapterWalletProvider;
const MOCK_PRIVATE_STATE_PASSWORD = "Aa1!mockseedfortest";
const MOCK_NETWORK = "undeployed" as const;
// Provider mode has no wallet configuration to fall back on, so these are required.
const MOCK_PROVIDER_ENDPOINTS = {
  indexerEndpoint: "http://indexer.test/api/v4/graphql",
  indexerWsEndpoint: "ws://indexer.test/api/v4/graphql/ws",
  proofServerEndpoint: "http://proof-server.test:6300",
};
const MOCK_PROOF_SERVER_ENDPOINT = MOCK_PROVIDER_ENDPOINTS.proofServerEndpoint;

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
        ...MOCK_PROVIDER_ENDPOINTS,
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
          ...MOCK_PROVIDER_ENDPOINTS,
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
          ...MOCK_PROVIDER_ENDPOINTS,
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
          ...MOCK_PROVIDER_ENDPOINTS,
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
            proofServerEndpoint: MOCK_PROOF_SERVER_ENDPOINT,
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
            ...MOCK_PROVIDER_ENDPOINTS,
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
            proofServerEndpoint: MOCK_PROOF_SERVER_ENDPOINT,
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
            ...MOCK_PROVIDER_ENDPOINTS,
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
          ...MOCK_PROVIDER_ENDPOINTS,
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

  describe("endpoint config", () => {
    it.each([
      [
        "indexerEndpoint",
        ChainErrorCode.MIDNIGHT_INDEXER_HTTP_NOT_SET,
      ] as const,
      [
        "indexerWsEndpoint",
        ChainErrorCode.MIDNIGHT_INDEXER_WS_NOT_SET,
      ] as const,
      [
        "proofServerEndpoint",
        ChainErrorCode.MIDNIGHT_PROOF_SERVER_NOT_SET,
      ] as const,
    ])(
      "provider mode throws when %s is not set (no default)",
      (field, code) => {
        const endpoints: Partial<typeof MOCK_PROVIDER_ENDPOINTS> = {
          ...MOCK_PROVIDER_ENDPOINTS,
        };
        delete endpoints[field];
        let err: unknown;
        try {
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
            ...endpoints,
          });
        } catch (e) {
          err = e;
        }
        expect(err).toMatchObject({
          code,
          message: expect.stringContaining(
            `[dStorage/midnight] ${field} is required (walletMode: "provider")`,
          ),
        });
      },
    );

    it("accepts a network without a preset when endpoints are given", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: "my-custom-net",
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
            ...MOCK_PROVIDER_ENDPOINTS,
          }),
      ).not.toThrow();
    });

    it("connector mode does not require indexer endpoints", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            network: "my-custom-net",
            walletMode: "connector",
            proofServerEndpoint: MOCK_PROOF_SERVER_ENDPOINT,
          }),
      ).not.toThrow();
    });

    it("accepts custom nodeEndpoint", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
            ...MOCK_PROVIDER_ENDPOINTS,
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
            ...MOCK_PROVIDER_ENDPOINTS,
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
            ...MOCK_PROVIDER_ENDPOINTS,
            proofServerEndpoint: "http://proof-server.internal:6300",
          }),
      ).not.toThrow();
    });

    it("connector mode requires proofServerEndpoint with the default prover", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "connector",
            zkConfigBaseUrl: "http://localhost:3000",
          }),
      ).toThrow(
        expect.objectContaining({
          code: ChainErrorCode.MIDNIGHT_PROOF_SERVER_NOT_SET,
          message: expect.stringContaining(
            `prover: "${PROVER_MODE.PROOF_SERVER_URL}"`,
          ),
        }),
      );
    });

    it.each([
      PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER,
      PROVER_MODE.WALLET_DELEGATED,
    ])(
      "connector mode accepts prover %s without proofServerEndpoint",
      (prover) => {
        expect(
          () =>
            new MidnightChainAdapter({
              contractAddress: VALID_ADDR,
              network: MOCK_NETWORK,
              walletMode: "connector",
              zkConfigBaseUrl: "http://localhost:3000",
              prover,
            }),
        ).not.toThrow();
      },
    );

    it.each([
      PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER,
      PROVER_MODE.WALLET_DELEGATED,
    ])(
      "connector mode rejects proofServerEndpoint with prover %s",
      (prover) => {
        expect(
          () =>
            new MidnightChainAdapter({
              contractAddress: VALID_ADDR,
              network: MOCK_NETWORK,
              walletMode: "connector",
              proofServerEndpoint: MOCK_PROOF_SERVER_ENDPOINT,
              prover,
            }),
        ).toThrow(
          expect.objectContaining({
            code: ChainErrorCode.MIDNIGHT_INVALID_PROVER_CONFIG,
            message: expect.stringContaining(
              "proofServerEndpoint must not be set",
            ),
          }),
        );
      },
    );

    it("connector mode rejects an unknown prover", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "connector",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            prover: "wallet" as any,
          }),
      ).toThrow(
        expect.objectContaining({
          code: ChainErrorCode.MIDNIGHT_INVALID_PROVER_CONFIG,
          message: expect.stringContaining('Unknown prover "wallet"'),
        }),
      );
    });

    it("rejects the removed allowWalletProofServer option with a migration hint", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "connector",
            allowWalletProofServer: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any),
      ).toThrow(
        expect.objectContaining({
          code: ChainErrorCode.MIDNIGHT_INVALID_PROVER_CONFIG,
          message: expect.stringContaining(
            "PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER",
          ),
        }),
      );
    });

    it("provider mode rejects the prover option", () => {
      expect(
        () =>
          new MidnightChainAdapter({
            contractAddress: VALID_ADDR,
            network: MOCK_NETWORK,
            walletMode: "provider",
            walletProvider: MOCK_WALLET_PROVIDER,
            privateStatePassword: MOCK_PRIVATE_STATE_PASSWORD,
            ...MOCK_PROVIDER_ENDPOINTS,
            prover: PROVER_MODE.WALLET_DELEGATED,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any),
      ).toThrow(
        expect.objectContaining({
          code: ChainErrorCode.MIDNIGHT_INVALID_PROVER_CONFIG,
        }),
      );
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
        ...MOCK_PROVIDER_ENDPOINTS,
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
        proofServerEndpoint: MOCK_PROOF_SERVER_ENDPOINT,
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
        ...MOCK_PROVIDER_ENDPOINTS,
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
        ...MOCK_PROVIDER_ENDPOINTS,
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
        ...MOCK_PROVIDER_ENDPOINTS,
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

  // ── Connector mode: configured settings vs wallet configuration ───────────

  describe("connector mode endpoint/network precedence", () => {
    const WALLET_CONFIG = {
      indexerUri: "https://wallet-indexer.example/api/v4/graphql",
      indexerWsUri: "wss://wallet-indexer.example/api/v4/graphql/ws",
      proverServerUri: "https://wallet-prover.example",
      substrateNodeUri: "wss://wallet-node.example",
      networkId: MOCK_NETWORK,
    };

    function makeMockLogger() {
      return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    }

    async function initWithWalletConfig(
      config: Partial<
        Extract<
          ConstructorParameters<typeof MidnightChainAdapter>[0],
          { walletMode: "connector" }
        >
      >,
      walletConfig: Promise<unknown>,
    ) {
      const connectedAPI = {
        getConfiguration: vi.fn().mockReturnValue(walletConfig),
        getShieldedAddresses: vi.fn().mockResolvedValue({
          shieldedAddress: "fake-shielded-address",
          shieldedCoinPublicKey: "fake-coin-pk",
          shieldedEncryptionPublicKey: "fake-enc-pk",
        }),
        getUnshieldedAddress: vi.fn().mockRejectedValue(new Error("n/a")),
        getDustAddress: vi.fn().mockRejectedValue(new Error("n/a")),
        getProvingProvider: vi.fn(),
      };
      const wallet = {
        name: "lace",
        rdns: "io.lace.wallet",
        apiVersion: "4.0.0",
        connect: vi.fn().mockResolvedValue(connectedAPI),
      };
      vi.stubGlobal("window", { midnight: { lace: wallet } });
      const logger = makeMockLogger();
      const adapter = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "connector",
        logger,
        ...config,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = adapter as any;
      await a._initConnector();
      return {
        wallet,
        logger,
        connectedAPI,
        buildProviders: () => a._buildConnectorProviders() as Promise<unknown>,
        resolve: () =>
          a._resolveConnectorEndpoints() as {
            indexerHttp: string;
            indexerWs: string;
            proofServer: string;
          },
      };
    }

    it("configured endpoints take priority over the wallet's", async () => {
      const { resolve, logger } = await initWithWalletConfig(
        {
          indexerEndpoint: "http://my-indexer/graphql",
          indexerWsEndpoint: "ws://my-indexer/graphql/ws",
          proofServerEndpoint: "http://my-prover:6300",
        },
        Promise.resolve(WALLET_CONFIG),
      );
      expect(resolve()).toEqual({
        indexerHttp: "http://my-indexer/graphql",
        indexerWs: "ws://my-indexer/graphql/ws",
        proofServer: "http://my-prover:6300",
      });
      expect(logger.log).toHaveBeenCalledWith(
        "dStorage/midnight",
        expect.stringContaining(
          'Using configured indexerEndpoint "http://my-indexer/graphql"',
        ),
      );
    });

    it("uses the wallet's indexer endpoints when none are configured", async () => {
      const { resolve } = await initWithWalletConfig(
        { proofServerEndpoint: "http://my-prover:6300" },
        Promise.resolve(WALLET_CONFIG),
      );
      expect(resolve()).toEqual({
        indexerHttp: WALLET_CONFIG.indexerUri,
        indexerWs: WALLET_CONFIG.indexerWsUri,
        proofServer: "http://my-prover:6300",
      });
    });

    it("uses the wallet's proof server with prover WALLET_CONFIGURED_PROOF_SERVER", async () => {
      const { resolve, logger } = await initWithWalletConfig(
        { prover: PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER },
        Promise.resolve(WALLET_CONFIG),
      );
      expect(resolve().proofServer).toBe(WALLET_CONFIG.proverServerUri);
      expect(logger.warn).toHaveBeenCalledWith(
        "dStorage/midnight",
        expect.stringContaining("Using wallet-supplied proof server"),
      );
    });

    it("ignores the wallet's proof server with the default prover", async () => {
      const { resolve } = await initWithWalletConfig(
        { proofServerEndpoint: "http://my-prover:6300" },
        Promise.resolve(WALLET_CONFIG),
      );
      expect(resolve().proofServer).toBe("http://my-prover:6300");
    });

    it("throws MIDNIGHT_PROOF_SERVER_NOT_SET when the wallet reports no proof server", async () => {
      const { proverServerUri: _omit, ...walletConfigWithoutProver } =
        WALLET_CONFIG;
      const { resolve } = await initWithWalletConfig(
        { prover: PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER },
        Promise.resolve(walletConfigWithoutProver),
      );
      expect(() => resolve()).toThrow(
        expect.objectContaining({
          code: ChainErrorCode.MIDNIGHT_PROOF_SERVER_NOT_SET,
        }),
      );
    });

    it("never falls back to wallet-delegated proving when the wallet's proof server is unusable", async () => {
      const { proverServerUri: _omit, ...walletConfigWithoutProver } =
        WALLET_CONFIG;
      const { buildProviders, connectedAPI } = await initWithWalletConfig(
        {
          prover: PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER,
          zkConfigBaseUrl: "http://localhost:3000",
        },
        Promise.resolve(walletConfigWithoutProver),
      );
      await expect(buildProviders()).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_PROOF_SERVER_NOT_SET,
      });
      expect(connectedAPI.getProvingProvider).not.toHaveBeenCalled();
    });

    it("ignores a non-http wallet proof server", async () => {
      const { resolve } = await initWithWalletConfig(
        { prover: PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER },
        Promise.resolve({
          ...WALLET_CONFIG,
          proverServerUri: "javascript:alert(1)",
        }),
      );
      expect(() => resolve()).toThrow(
        expect.objectContaining({
          code: ChainErrorCode.MIDNIGHT_PROOF_SERVER_NOT_SET,
        }),
      );
    });

    it("resolves no proof server with prover WALLET_DELEGATED", async () => {
      const { resolve } = await initWithWalletConfig(
        { prover: PROVER_MODE.WALLET_DELEGATED },
        Promise.resolve(WALLET_CONFIG),
      );
      expect(resolve()).toEqual({
        indexerHttp: WALLET_CONFIG.indexerUri,
        indexerWs: WALLET_CONFIG.indexerWsUri,
        proofServer: null,
      });
    });

    it("has no built-in fallback when getConfiguration() fails", async () => {
      const { resolve } = await initWithWalletConfig(
        { proofServerEndpoint: "http://my-prover:6300" },
        Promise.reject(new Error("no config")),
      );
      expect(() => resolve()).toThrow(
        expect.objectContaining({
          code: ChainErrorCode.MIDNIGHT_INDEXER_HTTP_NOT_SET,
        }),
      );
    });

    it("connects with the configured network", async () => {
      const { wallet } = await initWithWalletConfig(
        { proofServerEndpoint: "http://my-prover:6300" },
        Promise.resolve(WALLET_CONFIG),
      );
      expect(wallet.connect).toHaveBeenCalledWith(MOCK_NETWORK);
    });

    it("throws MIDNIGHT_NETWORK_MISMATCH when the wallet is on another network", async () => {
      await expect(
        initWithWalletConfig(
          { proofServerEndpoint: "http://my-prover:6300" },
          Promise.resolve({ ...WALLET_CONFIG, networkId: "preprod" }),
        ),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_NETWORK_MISMATCH,
        message: expect.stringContaining(
          `[dStorage/midnight] Wallet is connected to network "preprod" but the adapter is configured for "${MOCK_NETWORK}"`,
        ),
      });
    });
  });

  // ── Connector mode: wallet-delegated proving ──────────────────────────────

  describe("wallet-delegated proving", () => {
    const KEY_MATERIAL = { getZKIR: vi.fn() };
    const zkConfigProvider = {
      asKeyMaterialProvider: vi.fn(() => KEY_MATERIAL),
    };

    function makeAdapter() {
      return new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "connector",
        zkConfigBaseUrl: "http://localhost:3000",
        prover: PROVER_MODE.WALLET_DELEGATED,
      });
    }

    async function buildWalletProofProvider(connectorAPI: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = makeAdapter() as any;
      const proofProvider = await a._buildWalletProofProvider(
        connectorAPI,
        zkConfigProvider,
      );
      return { proofProvider, provingProvider: lastProvingProvider() };
    }

    it("gets the wallet's proving provider with the ZK key material", async () => {
      const proof = new Uint8Array([1, 2, 3]);
      const walletProving = {
        check: vi.fn().mockResolvedValue([1n]),
        prove: vi.fn().mockResolvedValue(proof),
      };
      const connectorAPI = {
        getProvingProvider: vi.fn().mockResolvedValue(walletProving),
      };
      const { provingProvider } = await buildWalletProofProvider(connectorAPI);

      expect(connectorAPI.getProvingProvider).toHaveBeenCalledWith(
        KEY_MATERIAL,
      );
      const preimage = new Uint8Array([9]);
      await expect(
        provingProvider.prove(preimage, "storeReference", 5n),
      ).resolves.toBe(proof);
      expect(walletProving.prove).toHaveBeenCalledWith(
        preimage,
        "storeReference",
        5n,
      );
      await expect(
        provingProvider.check(preimage, "storeReference"),
      ).resolves.toEqual([1n]);
    });

    it("throws MIDNIGHT_WALLET_PROVING_FAILED when the wallet has no proving provider", async () => {
      const connectorAPI = {
        getProvingProvider: vi.fn().mockRejectedValue({
          type: "DAppConnectorAPIError",
          code: "InvalidRequest",
          reason: "proving not supported",
        }),
      };
      await expect(
        buildWalletProofProvider(connectorAPI),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_WALLET_PROVING_FAILED,
        message: expect.stringContaining("proving not supported"),
      });
    });

    it("wraps wallet prove failures as MIDNIGHT_WALLET_PROVING_FAILED", async () => {
      const connectorAPI = {
        getProvingProvider: vi.fn().mockResolvedValue({
          check: vi.fn(),
          prove: vi.fn().mockRejectedValue(new Error("prover crashed")),
        }),
      };
      const { provingProvider } = await buildWalletProofProvider(connectorAPI);
      await expect(
        provingProvider.prove(new Uint8Array(), "storeReference"),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_WALLET_PROVING_FAILED,
        message: expect.stringContaining("prover crashed"),
      });
    });

    it("proveTx surfaces the wallet error even when the WASM rewords it", async () => {
      const connectorAPI = {
        getProvingProvider: vi.fn().mockResolvedValue({
          check: vi.fn().mockRejectedValue(new Error("prover crashed")),
          prove: vi.fn(),
        }),
      };
      const { proofProvider } = await buildWalletProofProvider(connectorAPI);
      const tx = {
        prove: async (p: TestProvingProvider) => {
          await p.check(new Uint8Array(), "storeReference").catch(() => {
            throw new Error("JsValue(Object({}))");
          });
        },
      };
      await expect(proofProvider.proveTx(tx)).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_WALLET_PROVING_FAILED,
        message: expect.stringContaining("prover crashed"),
      });
    });
  });

  // ── Proof server proving ───────────────────────────────────────────────────

  describe("proof server proving", () => {
    afterEach(() => {
      vi.doUnmock("@midnight-ntwrk/midnight-js-http-client-proof-provider");
    });

    async function buildHttpProofProvider(base: {
      check?: unknown;
      prove?: unknown;
    }) {
      const httpClientProvingProvider = vi.fn(() => ({
        check: base.check ?? vi.fn(),
        prove: base.prove ?? vi.fn(),
      }));
      vi.doMock(
        "@midnight-ntwrk/midnight-js-http-client-proof-provider",
        () => ({
          httpClientProvingProvider,
        }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "connector",
        proofServerEndpoint: MOCK_PROOF_SERVER_ENDPOINT,
      }) as any;
      const zkConfigProvider = {};
      const proofProvider = await a._buildHttpProofProvider(
        MOCK_PROOF_SERVER_ENDPOINT,
        zkConfigProvider,
      );
      expect(httpClientProvingProvider).toHaveBeenCalledWith(
        MOCK_PROOF_SERVER_ENDPOINT,
        zkConfigProvider,
      );
      return { proofProvider, provingProvider: lastProvingProvider() };
    }

    // Mimics the ledger WASM: the check() rejection comes back out reworded.
    const opaqueTx = {
      prove: async (p: TestProvingProvider) => {
        await p.check(new Uint8Array(), "storeReference").catch(() => {
          throw new Error("JsValue(TypeError)");
        });
      },
    };

    it("names the proof server when it cannot be reached", async () => {
      const { proofProvider } = await buildHttpProofProvider({
        check: vi.fn().mockRejectedValue(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          }),
        ),
      });
      const err = await proofProvider.proveTx(opaqueTx).catch((e: Error) => e);
      expect(err).toMatchObject({
        code: ChainErrorCode.MIDNIGHT_PROOF_SERVER_FAILED,
      });
      expect(err.message).toContain(
        `Proof server at ${MOCK_PROOF_SERVER_ENDPOINT} failed to check the proof preimage`,
      );
      expect(err.message).toContain("could not connect (ECONNREFUSED)");
      expect(err.message).toMatch(/^\[dStorage\/midnight\]/);
    });

    it("reports a timed-out request", async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      const { proofProvider } = await buildHttpProofProvider({
        check: vi.fn().mockRejectedValue(timeout),
      });
      await expect(proofProvider.proveTx(opaqueTx)).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_PROOF_SERVER_FAILED,
        message: expect.stringContaining("request timed out"),
      });
    });

    it("reports a non-2xx proof server response from prove()", async () => {
      const httpErr = new Error(
        'Failed Proof Server response: url="x", code="500", status="Internal Server Error"',
      );
      const { provingProvider } = await buildHttpProofProvider({
        prove: vi.fn().mockRejectedValue(httpErr),
      });
      await expect(
        provingProvider.prove(new Uint8Array(), "storeReference"),
      ).rejects.toMatchObject({
        code: ChainErrorCode.MIDNIGHT_PROOF_SERVER_FAILED,
        message: expect.stringContaining(
          'failed to generate the proof: Failed Proof Server response: url="x", code="500"',
        ),
        cause: httpErr,
      });
    });

    it("rethrows non-proving errors from proveTx unchanged", async () => {
      const { proofProvider } = await buildHttpProofProvider({});
      const boom = new Error("unrelated ledger failure");
      await expect(
        proofProvider.proveTx({
          prove: async () => {
            throw boom;
          },
        }),
      ).rejects.toBe(boom);
    });
  });

  // ── Proof retries ──────────────────────────────────────────────────────────

  describe("proof retries", () => {
    function makeAdapter() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new MidnightChainAdapter({
        contractAddress: VALID_ADDR,
        network: MOCK_NETWORK,
        walletMode: "connector",
        proofServerEndpoint: MOCK_PROOF_SERVER_ENDPOINT,
        proofServerMaxRetries: 3,
      }) as any;
    }

    it.each(["Rejected", "PermissionRejected"])(
      "does not retry when the user declines the wallet prompt (%s)",
      async (code) => {
        const rejection = {
          type: "DAppConnectorAPIError",
          code,
          reason: "User rejected",
        };
        const fn = vi
          .fn()
          .mockRejectedValue(new Error("wrapped", { cause: rejection }));
        await expect(
          makeAdapter()._withProofRetry(fn, "storeReference"),
        ).rejects.toThrow("wrapped");
        expect(fn).toHaveBeenCalledTimes(1);
      },
    );

    it("retries other failures", async () => {
      vi.useFakeTimers();
      try {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error("proof server busy"))
          .mockResolvedValue("ok");
        const result = makeAdapter()._withProofRetry(fn, "storeReference");
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(result).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
