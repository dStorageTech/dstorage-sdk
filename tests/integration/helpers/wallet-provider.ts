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

// ── Local environment config type ─────────────────────────────────────────────
export interface EnvironmentConfiguration {
  walletNetworkId: string;
  networkId: string;
  indexer: string;
  indexerWS: string;
  node: string;
  nodeWS: string;
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
  private readonly keystore: UnshieldedKeystore;

  private constructor(
    environmentConfiguration: EnvironmentConfiguration,
    wallet: WalletFacade,
    zswapSecretKeys: ZswapSecretKeys,
    dustSecretKey: DustSecretKey,
    keystore: UnshieldedKeystore,
  ) {
    this.env = environmentConfiguration;
    this.wallet = wallet;
    this.zswapSecretKeys = zswapSecretKeys;
    this.dustSecretKey = dustSecretKey;
    this.keystore = keystore;
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

  static async build(
    env: EnvironmentConfiguration,
    seed?: string,
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
      networkId: env.walletNetworkId,
      indexerClientConnection: {
        indexerHttpUrl: env.indexer,
        indexerWsUrl: env.indexerWS,
      },
      relayURL: new URL(env.nodeWS),
      provingServerUrl: new URL(env.proofServer),
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
      costParameters: {
        additionalFeeOverhead,
        feeBlocksMargin: 5,
      },
    };

    // Dust protocol parameters from the initial ledger state.
    const dustParameters = LedgerParameters.initialParameters().dust;

    const keystore = createKeystore(unshieldedSeed, env.walletNetworkId);
    const shieldedWallet =
      ShieldedWallet(walletConfig).startWithSeed(shieldedSeed);
    const unshieldedWallet = UnshieldedWallet(walletConfig).startWithPublicKey(
      PublicKey.fromKeyStore(keystore),
    );
    const dustWallet = DustWallet(walletConfig).startWithSeed(
      dustSeed,
      dustParameters,
    );

    const walletFacade = await WalletFacade.init({
      configuration: walletConfig,
      shielded: () => shieldedWallet,
      unshielded: () => unshieldedWallet,
      dust: () => dustWallet,
    });

    return new MidnightWalletProvider(
      env,
      walletFacade,
      ZswapSecretKeys.fromSeed(shieldedSeed),
      DustSecretKey.fromSeed(dustSeed),
      keystore,
    );
  }
}
