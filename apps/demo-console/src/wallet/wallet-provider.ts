import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type CoinPublicKey,
  type EncPublicKey,
  ZswapSecretKeys,
} from "@midnight-ntwrk/midnight-js-protocol/v9";
import {
  type FinalizedTx,
  LedgerTransaction,
  type MidnightProvider,
  type UnboundTx,
  type WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import {
  NetworkId,
  NoOpTransactionHistoryStorage,
} from "@midnightntwrk/wallet-sdk";
import { WalletFacade } from "@midnightntwrk/wallet-sdk/facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk/shielded";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk/unshielded";
import { DustWallet } from "@midnightntwrk/wallet-sdk/dust";
import { WalletSeeds } from "@midnightntwrk/wallet-sdk/hd";
import { isNodeSocketClosedError } from "../errors.js";
import { hexToBytes } from "@dstorage-tech/dstorage-sdk";

// ── Wallet state cache ─────────────────────────────────────────────────────────

interface WalletStateCache {
  shielded: string;
  dust: string;
  unshielded: string;
}

function walletCachePath(cacheDir: string, walletId: string): string {
  return path.join(cacheDir, `wallet-state-${walletId}.json`);
}

async function loadWalletCache(
  filePath: string,
): Promise<WalletStateCache | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as WalletStateCache;
  } catch {
    return null;
  }
}

async function saveWalletCacheFile(
  filePath: string,
  cache: WalletStateCache,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(cache), "utf8");
}

// ── Local environment config type ─────────────────────────────────────────────
export interface EnvironmentConfiguration {
  networkId: NetworkId.NetworkId;
  indexerHttp: string;
  indexerWs: string;
  nodeHttp: string;
  nodeWs: string;
  proofServer: string;
}

// ── Provider ───────────────────────────────────────────────────────────────────

/**
 * Provider class that implements wallet functionality for the Midnight network.
 * Handles transaction balancing, submission, and wallet state management.
 *
 * Built directly from wallet-sdk-* packages.
 */
export class MidnightWalletProvider
  implements MidnightProvider, WalletProvider
{
  readonly supportedEras = ["v9"] as const;
  readonly env: EnvironmentConfiguration;
  readonly wallet: WalletFacade;
  readonly cacheFilePath: string;
  private readonly seeds: WalletSeeds;
  private readonly zswapSecretKeys: ZswapSecretKeys;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _shieldedWallet: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _dustWallet: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _unshieldedWallet: any;

  private constructor(
    environmentConfiguration: EnvironmentConfiguration,
    wallet: WalletFacade,
    seeds: WalletSeeds,
    cacheFilePath: string,
    shieldedWallet: unknown,
    dustWallet: unknown,
    unshieldedWallet: unknown,
  ) {
    this.env = environmentConfiguration;
    this.wallet = wallet;
    this.seeds = seeds;
    // Only read for the public keys the contract calls need.
    this.zswapSecretKeys = ZswapSecretKeys.fromSeed(seeds.shielded);
    this.cacheFilePath = cacheFilePath;
    this._shieldedWallet = shieldedWallet;
    this._dustWallet = dustWallet;
    this._unshieldedWallet = unshieldedWallet;
  }

  getCoinPublicKey(): CoinPublicKey {
    return this.zswapSecretKeys.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.zswapSecretKeys.encryptionPublicKey;
  }

  // The wallet runs its own copy of the ledger: transactions cross between
  // Midnight.js and the wallet as bytes.
  async balanceTx(
    tx: UnboundTx,
    ttl: Date = ttlOneHour(),
  ): Promise<FinalizedTx> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      this.wallet.adoptTransaction(tx.serialize(), "Unbound"),
      {
        ttl,
        tokenKindsToBalance: ["dust"], // only DUST
      },
    );
    const finalized = await this.wallet.finalizeRecipe(recipe);
    return LedgerTransaction.fromBytes(
      "v9",
      "Finalized",
      finalized.serialize(),
    );
  }

  async submitTx(handle: FinalizedTx): Promise<string> {
    const tx = this.wallet.adoptTransaction(handle.serialize(), "Finalized");
    // wallet-sdk-node-client race: after each submission it calls
    // api.disconnect(), which resolves before the WebSocket has actually
    // closed. The next submission sees `isConnected === true`, skips the
    // reconnect, and sends on the closing socket — failing with
    // "disconnected from <node>: 1000:: Normal Closure". Invisible against a
    // local node (the close is instant), but routine against a remote RPC
    // such as Blockfrost. The request never reaches the node and the facade
    // reverts the tx on failure, so retrying is safe; by then the old socket
    // is closed and the client reconnects properly.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.wallet.submitTransaction(tx);
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isNodeSocketClosedError(err)) throw err;
        console.warn(
          `Node connection was closing during submission (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`,
        );
        await new Promise((r) => setTimeout(r, 1_000 * attempt));
      }
    }
  }

  // We do not wait for funds, it's done outside
  async start(): Promise<void> {
    console.log("Starting wallet...");
    await this.wallet.start(this.seeds);
  }

  async stop(): Promise<void> {
    return this.wallet.stop();
  }

  async saveState(): Promise<void> {
    if (!this._shieldedWallet || !this._dustWallet || !this._unshieldedWallet)
      return;
    const [shielded, dust, unshielded] = await Promise.all([
      this._shieldedWallet.serializeState(),
      this._dustWallet.serializeState(),
      this._unshieldedWallet.serializeState(),
    ]);
    await saveWalletCacheFile(this.cacheFilePath, {
      shielded,
      dust,
      unshielded,
    });
    console.debug(`Wallet state cached to: ${this.cacheFilePath}`);
  }

  static async build(
    env: EnvironmentConfiguration,
    seed?: string,
    cacheDir = path.join(process.cwd(), "midnight-wallet-cache"),
  ): Promise<MidnightWalletProvider> {
    // Derive per-role seeds from the master hex seed.
    // If no seed is provided, generate a random 32-byte master seed.
    const masterSeedHex =
      seed ??
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");

    // Same derivation as before (account 0, Zswap / NightExternal / Dust
    // roles, index 0), so existing wallets keep their addresses.
    const seeds = WalletSeeds.fromMasterSeed(
      hexToBytes(masterSeedHex, "masterSeedHex"),
    );

    const additionalFeeOverhead = 1_000n;

    const walletConfig = {
      networkId: env.networkId,
      indexerClientConnection: {
        indexerHttpUrl: env.indexerHttp,
        indexerWsUrl: env.indexerWs,
      },
      relayURL: new URL(env.nodeWs),
      provingServerUrl: new URL(env.proofServer),
      costParameters: {
        additionalFeeOverhead,
        feeBlocksMargin: 5,
      },
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
    };

    const keystore = createKeystore(
      { kind: "schnorr", secret: seeds.unshielded },
      env.networkId,
    );

    const walletId = createHash("sha256")
      .update("dstorage:wallet-id:v1:")
      .update(masterSeedHex)
      .update(":")
      .update(env.networkId)
      .digest("hex")
      .slice(0, 16);
    const cacheFilePath = walletCachePath(cacheDir, walletId);
    const cache = await loadWalletCache(cacheFilePath);
    if (cache) {
      console.log("Found wallet state cache, attempting restore...");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let shieldedWallet: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dustWallet: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let unshieldedWallet: any;

    const walletFacade = await WalletFacade.init({
      configuration: walletConfig,
      shielded: (cfg) => {
        if (cache) {
          try {
            shieldedWallet = ShieldedWallet(cfg).restore(cache.shielded);
            return shieldedWallet;
          } catch (e) {
            console.warn("Failed to restore shielded wallet from cache:", e);
          }
        }
        shieldedWallet = ShieldedWallet(cfg).startWithSeed(seeds.shielded);
        return shieldedWallet;
      },
      dust: (cfg) => {
        if (cache) {
          try {
            dustWallet = DustWallet(cfg).restore(cache.dust);
            return dustWallet;
          } catch (e) {
            console.warn("Failed to restore dust wallet from cache:", e);
          }
        }
        dustWallet = DustWallet(cfg).startWithSeed(seeds.dust);
        return dustWallet;
      },
      unshielded: (cfg) => {
        if (cache) {
          try {
            unshieldedWallet = UnshieldedWallet(cfg).restore(cache.unshielded);
            return unshieldedWallet;
          } catch (e) {
            console.warn("Failed to restore unshielded wallet from cache:", e);
          }
        }
        unshieldedWallet = UnshieldedWallet(cfg).startWithPublicKey(
          PublicKey.fromKeyStore(keystore),
        );
        return unshieldedWallet;
      },
    });

    return new MidnightWalletProvider(
      env,
      walletFacade,
      seeds,
      cacheFilePath,
      shieldedWallet,
      dustWallet,
      unshieldedWallet,
    );
  }
}
