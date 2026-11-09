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
import { WalletFacade } from "@midnightntwrk/wallet-sdk/facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk/shielded";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk/unshielded";
import { DustWallet } from "@midnightntwrk/wallet-sdk/dust";
import { WalletSeeds } from "@midnightntwrk/wallet-sdk/hd";
import {
  NetworkId,
  NoOpTransactionHistoryStorage,
} from "@midnightntwrk/wallet-sdk";

// ── Local environment config type ─────────────────────────────────────────────
export interface EnvironmentConfiguration {
  walletNetworkId: NetworkId.NetworkId;
  networkId: NetworkId.NetworkId;
  indexer: string;
  indexerWS: string;
  node: string;
  nodeWS: string;
  proofServer: string;
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
  readonly supportedEras = ["v9"] as const;
  readonly env: EnvironmentConfiguration;
  readonly wallet: WalletFacade;
  private readonly seeds: WalletSeeds;
  private readonly zswapSecretKeys: ZswapSecretKeys;

  private constructor(
    environmentConfiguration: EnvironmentConfiguration,
    wallet: WalletFacade,
    seeds: WalletSeeds,
  ) {
    this.env = environmentConfiguration;
    this.wallet = wallet;
    this.seeds = seeds;
    // Only read for the public keys the contract calls need.
    this.zswapSecretKeys = ZswapSecretKeys.fromSeed(seeds.shielded);
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

  submitTx(tx: FinalizedTx): Promise<string> {
    return this.wallet.submitTransaction(
      this.wallet.adoptTransaction(tx.serialize(), "Finalized"),
    );
  }

  // We do not wait for funds, it's done outside
  async start(): Promise<void> {
    console.log("Starting wallet...");
    await this.wallet.start(this.seeds);
  }

  async stop(): Promise<void> {
    return this.wallet.stop();
  }

  static async build(
    env: EnvironmentConfiguration,
    seed?: string,
  ): Promise<MidnightWalletProvider> {
    // Derive per-role seeds from the master hex seed (account 0, index 0).
    // If no seed is provided, generate a random 32-byte master seed.
    const masterSeed = seed
      ? hexToUint8Array(seed)
      : crypto.getRandomValues(new Uint8Array(32));
    const seeds = WalletSeeds.fromMasterSeed(masterSeed);

    const additionalFeeOverhead = 1_000n;

    const walletConfig = {
      networkId: env.walletNetworkId,
      indexerClientConnection: {
        indexerHttpUrl: env.indexer,
        indexerWsUrl: env.indexerWS,
      },
      relayURL: new URL(env.nodeWS),
      provingServerUrl: new URL(env.proofServer),
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
      costParameters: {
        additionalFeeOverhead,
        feeBlocksMargin: 5,
      },
    };

    const keystore = createKeystore(
      { kind: "schnorr", secret: seeds.unshielded },
      env.walletNetworkId,
    );

    const walletFacade = await WalletFacade.init({
      configuration: walletConfig,
      shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(seeds.shielded),
      unshielded: (cfg) =>
        UnshieldedWallet(cfg).startWithPublicKey(
          PublicKey.fromKeyStore(keystore),
        ),
      dust: (cfg) => DustWallet(cfg).startWithSeed(seeds.dust),
    });

    return new MidnightWalletProvider(env, walletFacade, seeds);
  }
}
