/**
 * @dstorage/storage — arweave-local.ts
 *
 * Local Arweave testing utilities built on top of arlocal:
 *   https://github.com/textury/arlocal
 *
 * arlocal is a zero-configuration local Arweave gateway for integration
 * testing. It accepts transactions without requiring real AR tokens, exposes
 * a /mint endpoint to fund test wallets instantly, and a /mine endpoint to
 * fast-forward block confirmation — all fully offline.
 *
 * ── Quick start ───────────────────────────────────────────────────────────────
 *
 *   # 1. Start arlocal (once per dev session) — Docker is recommended:
 *   docker run -d --rm -p 1984:1984 --name arlocal textury/arlocal
 *   # alternatively, without Docker:
 *   npx arlocal
 *
 *   # 2. In your code, use ArweaveLocalStorageAdapter instead of the real one
 *   const { adapter, walletKey, address } =
 *     await ArweaveLocalStorageAdapter.createWithTestWallet();
 *
 *   # 3. Mint test tokens
 *   await adapter.testnet.mintTokens(address, 5_000_000_000_000n); // 5 AR
 *
 *   # 4. Use exactly like ArweaveStorageAdapter
 *   const { id } = await adapter.upload('my encrypted data');
 *   await adapter.testnet.mine(); // confirm the tx instantly
 *   const data = await adapter.retrieve(id);
 *
 * ── Exports ───────────────────────────────────────────────────────────────────
 *
 *   ARWEAVE_MAINNET           — gateway preset for arweave.net
 *   ARWEAVE_LOCAL             — gateway preset for localhost:1984
 *   arlocalGateway(port)      — build a custom-port local preset
 *   ArweaveLocalHelper        — mint / mine / balance / reset helpers
 *   ArweaveLocalStorageAdapter — drop-in adapter for local testing
 *   ArweaveLocalError          — typed error thrown by helper methods
 */

import { ArweaveStorageAdapter } from "./arweave.js";
import type { ArweaveAdapterConfig, ArweaveGatewayConfig } from "./arweave.js";
import type { StorageProviderName, UploadResult } from "../types.js";

// ── Gateway presets ────────────────────────────────────────────────────────────

/**
 * Local arlocal gateway preset (default port 1984).
 *
 * @example
 * new ArweaveStorageAdapter({ gateway: ARWEAVE_LOCAL, walletKey: testJwk })
 * // or:
 * new ArweaveLocalStorageAdapter({ walletKey: testJwk })
 */
export const ARWEAVE_LOCAL: ArweaveGatewayConfig = {
  host: "localhost",
  port: 1984,
  protocol: "http",
};

/**
 * Build a local arlocal gateway preset on a non-default port.
 *
 * @example
 * const gw = arlocalGateway(1985);
 * new ArweaveLocalStorageAdapter({ gateway: gw, walletKey: testJwk })
 */
export function arlocalGateway(port = 1984): ArweaveGatewayConfig {
  return { host: "localhost", port, protocol: "http" };
}

// ── ArweaveLocalHelper ────────────────────────────────────────────────────────

export interface ArweaveLocalHelperConfig {
  /** Base URL of the arlocal instance. Defaults to 'http://localhost:1984'. */
  url?: string;
}

export interface ArweaveLocalInfo {
  network: string;
  version: number;
  release: number;
  height: number;
  current: string;
  peers: number;
  queue_length: number;
  node_state_latency: number;
}

export interface ArweaveLocalBalance {
  /** Raw balance in Winstons (1 AR = 1_000_000_000_000 Winstons). */
  winstons: string;
  /** Human-readable balance, e.g. "5" for 5 AR. */
  ar: string;
}

/**
 * Helper for controlling a running arlocal instance.
 *
 * Use this to fund test wallets, fast-forward block confirmations, and
 * inspect state during integration tests.
 *
 * @example
 * const helper = new ArweaveLocalHelper();
 * await helper.mintTokens(address, 1_000_000_000_000n); // 1 AR
 * await helper.mine();
 * const { ar } = await helper.getBalance(address);
 */
export class ArweaveLocalHelper {
  private readonly baseUrl: string;

  constructor(config: ArweaveLocalHelperConfig = {}) {
    this.baseUrl = (config.url ?? "http://localhost:1984").replace(/\/$/, "");
  }

  /**
   * Credit a wallet address with test AR tokens.
   *
   * The amount is in Winstons (1 AR = 1_000_000_000_000 Winstons).
   * Defaults to 1 AR if not specified.
   *
   * @example
   * await helper.mintTokens(address, 5_000_000_000_000n); // 5 AR
   */
  async mintTokens(
    address: string,
    winstons: bigint | number = 1_000_000_000_000n,
  ): Promise<void> {
    const amount =
      typeof winstons === "bigint" ? winstons.toString() : String(winstons);
    const res = await this.get(
      `/mint/${encodeURIComponent(address)}/${amount}`,
    );
    if (!res.ok) {
      throw new ArweaveLocalError(
        `mint failed for ${address}: HTTP ${res.status} ${await res.text()}`,
        res.status,
      );
    }
  }

  /**
   * Fast-forward the arlocal blockchain by mining one or more blocks.
   *
   * Pending transactions only become "confirmed" after a block is mined.
   * Call this after uploading if your test checks confirmed status
   * (e.g. when using `waitForConfirmation: true`).
   *
   * @example
   * await helper.mine();       // mine 1 block
   * await helper.mine(3);      // mine 3 blocks
   */
  async mine(blocks = 1): Promise<void> {
    for (let i = 0; i < blocks; i++) {
      const res = await this.get("/mine");
      if (!res.ok) {
        throw new ArweaveLocalError(
          `mine failed: HTTP ${res.status} ${await res.text()}`,
          res.status,
        );
      }
    }
  }

  /**
   * Query the AR token balance of a wallet address on arlocal.
   *
   * @example
   * const { ar, winstons } = await helper.getBalance(address);
   * console.log(`Balance: ${ar} AR (${winstons} winstons)`);
   */
  async getBalance(address: string): Promise<ArweaveLocalBalance> {
    const res = await this.get(
      `/wallet/${encodeURIComponent(address)}/balance`,
    );
    if (!res.ok) {
      throw new ArweaveLocalError(
        `getBalance failed for ${address}: HTTP ${res.status}`,
        res.status,
      );
    }
    const winstons = (await res.text()).trim();
    const ar = (BigInt(winstons) / 1_000_000_000_000n).toString();
    return { winstons, ar };
  }

  /**
   * Retrieve general info about the arlocal instance.
   * Useful for confirming the server is reachable before running tests.
   */
  async getInfo(): Promise<ArweaveLocalInfo> {
    const res = await this.get("/info");
    if (!res.ok) {
      throw new ArweaveLocalError(
        `getInfo failed: HTTP ${res.status}`,
        res.status,
      );
    }
    return res.json() as Promise<ArweaveLocalInfo>;
  }

  /**
   * Returns `true` if the arlocal instance is reachable, `false` otherwise.
   *
   * Use in `beforeAll` to skip integration tests gracefully when arlocal
   * is not running in the local environment.
   *
   * @example
   * beforeAll(async () => {
   *   if (!(await helper.isRunning())) {
   *     console.warn('arlocal not running — skipping integration tests');
   *   }
   * });
   */
  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/info`, {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Drop all transactions and reset arlocal state to a clean slate.
   * Only available when arlocal is started with persistence disabled (the default).
   */
  async reset(): Promise<void> {
    const res = await this.get("/reset");
    if (!res.ok) {
      throw new ArweaveLocalError(
        `reset failed: HTTP ${res.status}`,
        res.status,
      );
    }
  }

  private get(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`);
  }
}

// ── ArweaveLocalStorageAdapter ────────────────────────────────────────────────

export interface ArweaveLocalAdapterConfig extends Omit<
  ArweaveAdapterConfig,
  "gateway"
> {
  /**
   * Override the arlocal gateway (host/port).
   * Defaults to localhost:1984.
   */
  gateway?: ArweaveGatewayConfig;
}

/**
 * A storage adapter for local Arweave integration testing using arlocal.
 *
 * Identical API to `ArweaveStorageAdapter` but pre-configured for a local
 * arlocal instance. Exposes a `.testnet` helper for minting tokens, mining
 * blocks, and inspecting state — without touching the real Arweave network.
 *
 * ── Requirements ──────────────────────────────────────────────────────────────
 *
 *   Start arlocal (Docker recommended — no npm install needed):
 *        docker run -d --rm -p 1984:1984 --name arlocal textury/arlocal
 *      or, via npx (installs arlocal on demand):
 *        npx arlocal
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *
 * Option A — static factory (recommended for tests): auto-generates & funds wallet
 *
 *   const { adapter, walletKey, address } =
 *     await ArweaveLocalStorageAdapter.createWithTestWallet();
 *
 *   const ds = new DStorage({
 *     storageAdapter: adapter,
 *     chainAdapter:   new MockChainAdapter(),
 *   });
 *
 * Option B — manual config (when you already have a wallet):
 *
 *   const adapter = new ArweaveLocalStorageAdapter({ walletKey: myJwk });
 *   await adapter.testnet.mintTokens(address, 2_000_000_000_000n); // 2 AR
 *
 * ── Replacing the real adapter ────────────────────────────────────────────────
 *
 *   // Development / CI — local arlocal
 *   storageAdapter: new ArweaveLocalStorageAdapter({ walletKey: testJwk })
 *
 *   // Production — real Arweave mainnet
 *   storageAdapter: new ArweaveStorageAdapter({ walletKey: realJwk })
 */
export class ArweaveLocalStorageAdapter extends ArweaveStorageAdapter {
  override readonly name: StorageProviderName = "arweave";
  override readonly providerName: string = "Arweave-Local";

  /** Access arlocal control methods: mint, mine, balance, reset. */
  readonly testnet: ArweaveLocalHelper;

  constructor(config: ArweaveLocalAdapterConfig = {}) {
    const gateway = config.gateway ?? ARWEAVE_LOCAL;
    super({ ...config, gateway });

    const { protocol, host, port } = gateway;
    this.testnet = new ArweaveLocalHelper({
      url: `${protocol}://${host}:${port}`,
    });
  }

  /**
   * Factory method: generates a fresh Arweave wallet, mints test AR tokens
   * into it, and returns a fully-configured adapter ready for testing.
   *
   * Requires arlocal to be running at the given URL.
   *
   * @param options.fundAr    AR to mint into the test wallet (default: 10)
   * @param options.gateway   Override the arlocal gateway (default: localhost:1984)
   *
   * @example
   * const { adapter, walletKey, address } =
   *   await ArweaveLocalStorageAdapter.createWithTestWallet({ fundAr: 5 });
   *
   * // Then use adapter in your DStorage instance:
   * const ds = new DStorage({ storageAdapter: adapter, chainAdapter: new MockChainAdapter() });
   */
  static async createWithTestWallet(
    options: {
      fundAr?: number;
      gateway?: ArweaveGatewayConfig;
    } = {},
  ): Promise<{
    adapter: ArweaveLocalStorageAdapter;
    walletKey: Record<string, string>;
    address: string;
  }> {
    const gateway = options.gateway ?? ARWEAVE_LOCAL;
    const fundAr = options.fundAr ?? 10;

    // Dynamically import arweave-js to generate a wallet without a hard dep.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let arweaveModule: any;
    try {
      const mod = await import("arweave");
      arweaveModule = mod.default;
    } catch {
      throw new Error(
        "[dStorage/arweave-local] arweave package not found.\n" +
          "Install it with: npm install arweave",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const arweave = arweaveModule.init(gateway) as {
      wallets: {
        generate: () => Promise<Record<string, string>>;
        jwkToAddress: (jwk: Record<string, string>) => Promise<string>;
      };
    };
    const walletKey = await arweave.wallets.generate();
    const address = await arweave.wallets.jwkToAddress(walletKey);

    const adapter = new ArweaveLocalStorageAdapter({ walletKey, gateway });
    const winstons = BigInt(fundAr) * 1_000_000_000_000n;
    await adapter.testnet.mintTokens(address, winstons);

    return { adapter, walletKey, address };
  }

  // ── Overridden upload: log testnet context ──────────────────────────────────

  override async upload(
    data: Uint8Array,
    metadata: Record<string, string> = {},
  ): Promise<UploadResult> {
    const result = await super.upload(data, metadata);
    this.logger?.log(
      "dStorage/arweave-local",
      "⚠️  Testnet upload — data is NOT on the real Arweave network.",
    );
    this.logger?.log("dStorage/arweave-local", "Mining a block to confirm...");
    await this.testnet.mine();
    return result;
  }
}

// ── ArweaveLocalError ─────────────────────────────────────────────────────────

export class ArweaveLocalError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(`[dStorage/arweave-local] ${message}`);
    this.name = "ArweaveLocalError";
    this.statusCode = statusCode;
  }
}
