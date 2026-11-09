/**
 * Funds test wallets on the local "undeployed" devnet (tools/compose-undeployed.yml):
 * sends each one NIGHT from the devnet's genesis wallet and registers its NIGHT for DUST
 * generation, so it can pay transaction fees.
 *
 * Built on Wallet SDK 2 (ledger 9). Replaces midnightntwrk/midnight-local-dev, which is
 * archived and stops at Wallet SDK 1.x (ledger 8).
 *
 * Usage:
 *   npx tsx tools/fund-wallet.ts <mnemonic-or-hex-seed> [<mnemonic-or-hex-seed> ...]
 *
 * A mnemonic becomes its BIP-39 seed and a hex seed is used as is — the same master seed
 * the integration tests and the demo console derive their wallets from, so the funded
 * addresses are theirs.
 *
 * Environment (defaults match tools/compose-undeployed.yml):
 *   INTEGRATION_NODE_WS_ENDPOINT     ws://127.0.0.1:9944
 *   INTEGRATION_INDEXER_ENDPOINT     http://127.0.0.1:8088/api/v4/graphql
 *   INTEGRATION_INDEXER_WS_ENDPOINT  ws://127.0.0.1:8088/api/v4/graphql/ws
 *   INTEGRATION_PROOF_SERVER         http://127.0.0.1:6300
 *   FUND_NIGHT_AMOUNT                NIGHT to send each wallet (default 50000)
 */

import { mnemonicToSeedSync } from "@scure/bip39";
import * as Rx from "rxjs";
import { unshieldedToken } from "@midnightntwrk/wallet-sdk/ledger/v9";
import { NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk";
import {
  WalletFacade,
  type FacadeState,
} from "@midnightntwrk/wallet-sdk/facade";
import { WalletSeeds } from "@midnightntwrk/wallet-sdk/hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk/shielded";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from "@midnightntwrk/wallet-sdk/unshielded";
import {
  DustWallet,
  isInsufficientDustForFeeError,
} from "@midnightntwrk/wallet-sdk/dust";

// The wallet holding the tokens minted in the undeployed devnet's genesis block.
const GENESIS_SEED_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";
const NETWORK_ID = "undeployed";
const NIGHT_DECIMALS = 10n ** 6n;
const SYNC_TIMEOUT_MS = 10 * 60_000;
const FUNDS_TIMEOUT_MS = 5 * 60_000;

const env = {
  nodeWs: process.env.INTEGRATION_NODE_WS_ENDPOINT ?? "ws://127.0.0.1:9944",
  indexer:
    process.env.INTEGRATION_INDEXER_ENDPOINT ??
    "http://127.0.0.1:8088/api/v4/graphql",
  indexerWs:
    process.env.INTEGRATION_INDEXER_WS_ENDPOINT ??
    "ws://127.0.0.1:8088/api/v4/graphql/ws",
  proofServer: process.env.INTEGRATION_PROOF_SERVER ?? "http://127.0.0.1:6300",
};
const nightAmount =
  BigInt(process.env.FUND_NIGHT_AMOUNT ?? "50000") * NIGHT_DECIMALS;

interface Wallet {
  name: string;
  facade: WalletFacade;
  keystore: UnshieldedKeystore;
}

const log = (msg: string) => console.log(`[fund-wallet] ${msg}`);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("[dStorage/fund-wallet] not a hex seed");
  }
  return Uint8Array.from(clean.match(/../g)!, (b) => parseInt(b, 16));
}

/** A mnemonic's BIP-39 seed, or a hex seed's bytes. */
function masterSeedOf(secret: string): Uint8Array {
  return secret.trim().includes(" ")
    ? mnemonicToSeedSync(secret.trim())
    : hexToBytes(secret.trim());
}

async function startWallet(
  name: string,
  masterSeed: Uint8Array,
): Promise<Wallet> {
  const seeds = WalletSeeds.fromMasterSeed(masterSeed);
  const keystore = createKeystore(
    { kind: "schnorr", secret: seeds.unshielded },
    NETWORK_ID,
  );
  const facade = await WalletFacade.init({
    configuration: {
      networkId: NETWORK_ID,
      indexerClientConnection: {
        indexerHttpUrl: env.indexer,
        indexerWsUrl: env.indexerWs,
      },
      relayURL: new URL(env.nodeWs),
      provingServerUrl: new URL(env.proofServer),
      costParameters: { additionalFeeOverhead: 1_000n, feeBlocksMargin: 5 },
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(seeds.shielded),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(
        PublicKey.fromKeyStore(keystore),
      ),
    dust: (cfg) => DustWallet(cfg).startWithSeed(seeds.dust),
  });
  await facade.start(seeds);
  log(`${name}: ${keystore.getBech32Address().asString()}`);
  return { name, facade, keystore };
}

/** The first wallet state matching `predicate`, or an error after `timeoutMs`. */
function stateWhere(
  wallet: Wallet,
  predicate: (state: FacadeState) => boolean,
  what: string,
  timeoutMs: number,
): Promise<FacadeState> {
  return Rx.firstValueFrom(
    wallet.facade.state().pipe(
      Rx.filter(predicate),
      Rx.timeout({
        each: timeoutMs,
        with: () =>
          Rx.throwError(
            () =>
              new Error(
                `[dStorage/fund-wallet] ${wallet.name}: ${what} within ${timeoutMs / 1000}s`,
              ),
          ),
      }),
    ),
  );
}

const nightBalance = (state: FacadeState) =>
  state.unshielded.balances[unshieldedToken().raw] ?? 0n;

/**
 * Registers the wallet's unregistered NIGHT for DUST generation, then waits until it holds
 * DUST it can spend. A first registration pays its own fee from the DUST its NIGHT has
 * generated so far, so it may have to wait for enough to accrue.
 */
async function ensureDust(wallet: Wallet): Promise<void> {
  const state = await stateWhere(
    wallet,
    (s) => s.isSynced,
    "no sync",
    SYNC_TIMEOUT_MS,
  );
  const unregistered = state.unshielded.availableCoins.filter(
    (coin) => !coin.meta.registeredForDustGeneration,
  );
  if (unregistered.length > 0) {
    log(
      `${wallet.name}: registering ${unregistered.length} NIGHT UTXO(s) for DUST`,
    );
    const register = () =>
      wallet.facade.registerNightUtxosForDustGeneration(
        unregistered,
        wallet.keystore.getPublicKey(),
        wallet.keystore.signDataAsync,
      );
    const recipe = await register().catch(async (error: unknown) => {
      if (
        !isInsufficientDustForFeeError(error) ||
        error.estimate._tag !== "Reachable"
      ) {
        throw error;
      }
      const timeoutMs = Number(error.estimate.seconds) * 1000 + 60_000;
      log(
        `${wallet.name}: waiting up to ${timeoutMs / 1000}s for DUST to cover the fee`,
      );
      await wallet.facade.waitForGeneratedDust(unregistered, error.fee, {
        timeoutMs,
      });
      return register();
    });
    const txId = await wallet.facade.submitTransaction(
      await wallet.facade.finalizeRecipe(recipe),
    );
    log(`${wallet.name}: DUST registration submitted (${txId})`);
  }
  const funded = await stateWhere(
    wallet,
    (s) => s.dust.availableCoins.length > 0 && s.dust.balance(new Date()) > 0n,
    "no spendable DUST",
    FUNDS_TIMEOUT_MS,
  );
  log(`${wallet.name}: DUST balance ${funded.dust.balance(new Date())}`);
}

async function sendNight(
  from: Wallet,
  to: Wallet,
  amount: bigint,
): Promise<void> {
  const toState = await Rx.firstValueFrom(to.facade.state());
  const recipe = await from.facade.transferTransaction(
    [
      {
        type: "unshielded",
        outputs: [
          {
            type: unshieldedToken().raw,
            receiverAddress: toState.unshielded.address,
            amount,
          },
        ],
      },
    ],
    { ttl: new Date(Date.now() + 30 * 60_000) },
  );
  const signed = await from.facade.signRecipe(
    recipe,
    from.keystore.signDataAsync,
  );
  const txId = await from.facade.submitTransaction(
    await from.facade.finalizeRecipe(signed),
  );
  log(
    `${from.name} → ${to.name}: ${amount / NIGHT_DECIMALS} NIGHT submitted (${txId})`,
  );
}

async function main(secrets: string[]): Promise<void> {
  const wallets: Wallet[] = [];
  try {
    const genesis = await startWallet("genesis", hexToBytes(GENESIS_SEED_HEX));
    wallets.push(genesis);
    // The genesis wallet pays the transfer fees in DUST too.
    await ensureDust(genesis);

    for (const [i, secret] of secrets.entries()) {
      const wallet = await startWallet(
        `account ${i + 1}`,
        masterSeedOf(secret),
      );
      wallets.push(wallet);
      await stateWhere(wallet, (s) => s.isSynced, "no sync", SYNC_TIMEOUT_MS);
      if (nightBalance(await Rx.firstValueFrom(wallet.facade.state())) === 0n) {
        await sendNight(genesis, wallet, nightAmount);
      }
      const funded = await stateWhere(
        wallet,
        (s) => nightBalance(s) > 0n,
        "no NIGHT received",
        FUNDS_TIMEOUT_MS,
      );
      log(
        `${wallet.name}: NIGHT balance ${nightBalance(funded) / NIGHT_DECIMALS}`,
      );
      await ensureDust(wallet);
    }
    log(`Funded ${secrets.length} wallet(s).`);
  } finally {
    await Promise.allSettled(wallets.map((w) => w.facade.stop()));
  }
}

const secrets = process.argv.slice(2);
if (secrets.length === 0 || secrets[0] === "-h" || secrets[0] === "--help") {
  console.log(
    "Usage: npx tsx tools/fund-wallet.ts <mnemonic-or-hex-seed> [<mnemonic-or-hex-seed> ...]",
  );
  process.exit(secrets.length === 0 ? 1 : 0);
}
main(secrets).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
