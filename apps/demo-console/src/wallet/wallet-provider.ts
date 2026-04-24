import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type CoinPublicKey,
  DustSecretKey,
  type EncPublicKey,
  type FinalizedTransaction,
  LedgerParameters,
  ZswapSecretKeys,
} from "@midnight-ntwrk/ledger-v8";
import {
  type MidnightProvider,
  UnboundTransaction,
  type WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { HDWallet, Roles, Role } from "@midnight-ntwrk/wallet-sdk-hd";

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
  networkId: string;
  indexerHttp: string;
  indexerWs: string;
  nodeHttp: string;
  nodeWs: string;
  proofServer: string;
}

// ── Seed derivation ────────────────────────────────────────────────────────────

/**
 * Derive a single wallet role seed from a master hex seed via HD derivation.
 * HDWallet.fromSeed → selectAccount(0) → selectRole(role) → deriveKeyAt(0)
 */
function deriveRoleSeed(masterSeedHex: string, role: Role): Uint8Array {
  const seedBytes = hexToUint8Array(masterSeedHex);
  const result = HDWallet.fromSeed(seedBytes);
  if (result.type !== "seedOk") {
    throw new Error("HDWallet.fromSeed failed: invalid seed.");
  }
  const derivation = result.hdWallet
    .selectAccount(0)
    .selectRole(role)
    .deriveKeyAt(0);
  result.hdWallet.clear();
  if (derivation.type !== "keyDerived") {
    throw new Error(`Key derivation out of bounds for role ${role}.`);
  }
  return derivation.key;
}

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
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
  readonly env: EnvironmentConfiguration;
  readonly wallet: WalletFacade;
  readonly zswapSecretKeys: ZswapSecretKeys;
  readonly dustSecretKey: DustSecretKey;
  readonly cacheFilePath: string;
  private readonly keystore: UnshieldedKeystore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _shieldedWallet: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _dustWallet: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _unshieldedWallet: any;

  private constructor(
    environmentConfiguration: EnvironmentConfiguration,
    wallet: WalletFacade,
    zswapSecretKeys: ZswapSecretKeys,
    dustSecretKey: DustSecretKey,
    keystore: UnshieldedKeystore,
    cacheFilePath: string,
    shieldedWallet: unknown,
    dustWallet: unknown,
    unshieldedWallet: unknown,
  ) {
    this.env = environmentConfiguration;
    this.wallet = wallet;
    this.zswapSecretKeys = zswapSecretKeys;
    this.dustSecretKey = dustSecretKey;
    this.keystore = keystore;
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

  async balanceTx(
    tx: UnboundTransaction,
    ttl: Date = ttlOneHour(),
  ): Promise<FinalizedTransaction> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      tx,
      {
        shieldedSecretKeys: this.zswapSecretKeys,
        dustSecretKey: this.dustSecretKey,
      },
      {
        ttl,
        tokenKindsToBalance: ["dust"], // only DUST
      },
    );
    return await this.wallet.finalizeRecipe(recipe);
  }

  submitTx(tx: FinalizedTransaction): Promise<string> {
    return this.wallet.submitTransaction(tx);
  }

  // We do not wait for funds, it's done outside
  async start(): Promise<void> {
    console.log("Starting wallet...");
    await this.wallet.start(this.zswapSecretKeys, this.dustSecretKey);
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
    console.log(`Wallet state cached to: ${this.cacheFilePath}`);
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

    const shieldedSeed = deriveRoleSeed(masterSeedHex, Roles.Zswap);
    const unshieldedSeed = deriveRoleSeed(masterSeedHex, Roles.NightExternal);
    const dustSeed = deriveRoleSeed(masterSeedHex, Roles.Dust);

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
    };

    // Dust protocol parameters from the initial ledger state.
    const dustParameters = LedgerParameters.initialParameters().dust;

    const keystore = createKeystore(unshieldedSeed, env.networkId);

    const walletId = masterSeedHex.slice(0, 16);
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
      shielded: (cfg: any) => {
        if (cache) {
          try {
            shieldedWallet = ShieldedWallet(cfg).restore(cache.shielded);
            return shieldedWallet;
          } catch (e) {
            console.warn("Failed to restore shielded wallet from cache:", e);
          }
        }
        shieldedWallet = ShieldedWallet(cfg).startWithSeed(shieldedSeed);
        return shieldedWallet;
      },
      dust: (cfg: any) => {
        if (cache) {
          try {
            dustWallet = DustWallet(cfg).restore(cache.dust);
            return dustWallet;
          } catch (e) {
            console.warn("Failed to restore dust wallet from cache:", e);
          }
        }
        dustWallet = DustWallet(cfg).startWithSeed(dustSeed, dustParameters);
        return dustWallet;
      },
      unshielded: (cfg: any) => {
        if (cache) {
          try {
            unshieldedWallet = UnshieldedWallet({
              ...cfg,
              txHistoryStorage: new InMemoryTransactionHistoryStorage(),
            }).restore(cache.unshielded);
            return unshieldedWallet;
          } catch (e) {
            console.warn("Failed to restore unshielded wallet from cache:", e);
          }
        }
        unshieldedWallet = UnshieldedWallet({
          ...cfg,
          txHistoryStorage: new InMemoryTransactionHistoryStorage(),
        }).startWithPublicKey(PublicKey.fromKeyStore(keystore));
        return unshieldedWallet;
      },
    });

    return new MidnightWalletProvider(
      env,
      walletFacade,
      ZswapSecretKeys.fromSeed(shieldedSeed),
      DustSecretKey.fromSeed(dustSeed),
      keystore,
      cacheFilePath,
      shieldedWallet,
      dustWallet,
      unshieldedWallet,
    );
  }
}
