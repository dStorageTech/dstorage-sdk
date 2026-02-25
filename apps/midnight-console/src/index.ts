/**
 * dStorage Midnight Console Demo
 *
 * A real working CLI that:
 *  1. Accepts a BIP-39 mnemonic (or 64-byte hex seed) and derives Midnight wallet keys
 *  2. Builds a full Midnight wallet: ShieldedWallet + DustWallet + UnshieldedWallet → WalletFacade
 *  3. Connects to the Midnight indexer and waits for wallet sync
 *  4. Checks NIGHT and DUST balances (displays funding address if empty)
 *  5. Reads a DataRegistry contract reference via MidnightChainAdapter
 *
 * Reference implementations:
 *   - bricktowers/midnight-local-network: src/utils.ts (wallet construction)
 *   - midnightntwrk/example-bboard: bboard-cli/src/wallet-utils.ts (sync + balances)
 */

// ── WebSocket polyfill ────────────────────────────────────────────────────────
// The Midnight indexer uses GraphQL subscriptions over WebSocket.
// Node.js doesn't expose a global WebSocket; the `ws` package fills this gap.
import WebSocket from 'ws';
// @ts-expect-error — ws type doesn't perfectly match the DOM WebSocket interface
globalThis.WebSocket = WebSocket;

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { KeyDeriver } from '@dstorage/crypto';
import { MidnightChainAdapter } from '@dstorage/chain';

import * as ledger from '@midnight-ntwrk/ledger-v7';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey as UnshieldedPublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { firstValueFrom, filter } from 'rxjs';

// ── Network defaults ───────────────────────────────────────────────────────────

const NETWORKS = {
  preprod: {
    node: 'wss://rpc.preprod.midnight.network',
    indexerHttp: 'https://indexer.preprod.midnight.network/api/v3/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
    proofServer: 'http://localhost:6300',
  },
  undeployed: {
    node: 'ws://localhost:9944',
    indexerHttp: 'http://localhost:8088/api/v3/graphql',
    indexerWs: 'ws://localhost:8088/api/v3/graphql/ws',
    proofServer: 'http://localhost:6300',
  },
} as const;

type NetworkName = keyof typeof NETWORKS;

// ── Progress ticker ────────────────────────────────────────────────────────────

async function withTicker<T>(statusLine: () => string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const id = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  ${statusLine()} (${elapsed}s)`);
  }, 3000);
  try {
    return await fn();
  } finally {
    clearInterval(id);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  let facade: WalletFacade | undefined;

  try {
    console.log('\n=== dStorage Midnight Console Demo ===\n');

    // ── 1. Network selection ────────────────────────────────────────────────
    const networkInput =
      (await rl.question('Midnight network [preprod / undeployed, default: undeployed]: ')).trim() ||
      'undeployed';
    if (networkInput !== 'preprod' && networkInput !== 'undeployed') {
      throw new Error(`Unknown network "${networkInput}". Choose preprod or undeployed.`);
    }
    const networkName = networkInput as NetworkName;
    const defaults = NETWORKS[networkName];

    // Map user-facing network names to Midnight SDK network IDs
    const networkId = networkName === 'undeployed' ? 'undeployed' : networkName;
    setNetworkId(networkId);
    console.log(`Network: ${networkName} (networkId: ${networkId})\n`);

    // ── 2. Endpoints ────────────────────────────────────────────────────────
    const nodeEndpoint =
      (await rl.question(`Node RPC endpoint [${defaults.node}]: `)).trim() || defaults.node;
    const indexerHttp =
      (await rl.question(`Indexer HTTP endpoint [${defaults.indexerHttp}]: `)).trim() ||
      defaults.indexerHttp;
    const indexerWs =
      (await rl.question(`Indexer WS endpoint [${defaults.indexerWs}]: `)).trim() ||
      defaults.indexerWs;
    const proofServerEndpoint =
      (await rl.question(`Proof server endpoint [${defaults.proofServer}]: `)).trim() ||
      defaults.proofServer;

    // ── 3. Mnemonic or hex seed ─────────────────────────────────────────────
    console.log('\nEnter your BIP-39 mnemonic phrase (12 or 24 words) or a 64-byte hex seed.');
    const seedInput = await promptSecret('Mnemonic / hex seed: ');
    if (!seedInput) {
      throw new Error('Mnemonic or seed is required.');
    }

    // Detect hex seed vs mnemonic
    const isHex = /^[0-9a-fA-F]{128}$/.test(seedInput.trim());
    const deriver = isHex
      ? new KeyDeriver({ seedHex: seedInput.trim() })
      : new KeyDeriver({ mnemonic: seedInput.trim() });

    console.log('\nDeriving Midnight signing keys...');
    const { zswapSeed, dustSeed, nightExternalSeed } = await deriver.deriveMidnightSigningKeys();
    console.log('Key derivation successful.');

    // ── 4. Build wallet ─────────────────────────────────────────────────────
    console.log('\nBuilding Midnight wallet...');

    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(zswapSeed);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(dustSeed);
    const unshieldedKeystore = createKeystore(nightExternalSeed, networkId);

    const walletConfig = {
      networkId,
      costParameters: {
        additionalFeeOverhead:
          networkName === 'undeployed' ? 500_000_000_000_000_000n : 300_000_000_000_000_000n,
        feeBlocksMargin: 5,
      },
      relayURL: new URL(nodeEndpoint),
      provingServerUrl: new URL(proofServerEndpoint),
      indexerClientConnection: {
        indexerHttpUrl: indexerHttp,
        indexerWsUrl: indexerWs,
      },
      // Used by DustWallet internals
      indexerUrl: indexerWs,
    };

    const shielded = ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys);
    const dust = DustWallet(walletConfig).startWithSecretKey(
      dustSecretKey,
      ledger.LedgerParameters.initialParameters().dust
    );
    const unshielded = UnshieldedWallet({
      ...walletConfig,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(unshieldedKeystore));

    facade = new WalletFacade(shielded, unshielded, dust);
    console.log('Starting wallet (connecting to indexer)...');
    await facade.start(shieldedSecretKeys, dustSecretKey);
    console.log('Wallet started.');

    // ── 5. Display addresses ────────────────────────────────────────────────
    const initialState = await firstValueFrom(facade.state());
    const unshieldedAddr = UnshieldedAddress.codec.encode(
      getNetworkId(),
      initialState.unshielded.address ?? unshieldedKeystore
    );
    console.log('\nWallet addresses:');
    console.log(`  Unshielded: ${unshieldedAddr}`);
    console.log(
      `  Shielded:   (available after sync — check wallet state for bech32m address)`
    );

    // ── 6. Wait for sync ────────────────────────────────────────────────────
    console.log('\nSyncing wallet with indexer...');
    await withTicker(
      () => 'Syncing...',
      () => firstValueFrom(facade!.state().pipe(filter((s: { isSynced?: boolean }) => s.isSynced === true)))
    );
    console.log('Wallet synced.');

    // ── 7. Balance checks ───────────────────────────────────────────────────
    const syncedState = await firstValueFrom(facade.state());

    // NIGHT balance (unshielded token) — matches bboard reference: unshieldedToken().raw
    const nightToken = ledger.unshieldedToken();
    const nightBalance: bigint = syncedState.unshielded?.balances?.[nightToken.raw] ?? 0n;
    if (nightBalance === 0n) {
      console.log(`\nNo NIGHT tokens found. Send NIGHT to:\n  ${unshieldedAddr}`);
      console.log('Waiting for funds (Ctrl+C to abort)...');
      await withTicker(
        () => 'Waiting for NIGHT funds',
        () =>
          firstValueFrom(
            facade!
              .state()
              .pipe(filter((s) => (s.unshielded?.balances?.[ledger.unshieldedToken().raw] ?? 0n) > 0n))
          )
      );
      console.log('NIGHT funds detected!');
    } else {
      console.log(`\nNIGHT balance: ${nightBalance} (unshielded)`);
    }

    // DUST balance (needed for transaction fees)
    const dustBalance: bigint = syncedState.dust?.walletBalance?.(new Date()) ?? 0n;
    if (dustBalance === 0n) {
      console.log('Warning: No DUST found. DUST is required to pay transaction fees.');
      console.log('Generate DUST by shielding NIGHT, or use a funded wallet.');
    } else {
      console.log(`DUST balance: ${dustBalance}`);
    }

    // ── 8. Contract interaction ─────────────────────────────────────────────
    const contractAddress = (
      await rl.question('\nDataRegistry contract address on Midnight (required): ')
    ).trim();
    if (!contractAddress) {
      throw new Error('A contract address is required.');
    }

    const refId = (
      await rl.question('Reference ID to read (press Enter to skip): ')
    ).trim();

    console.log('\nInitialising chain adapter...');
    const chain = new MidnightChainAdapter({
      contractAddress,
      wallet: facade,
      nodeEndpoint,
      indexerEndpoint: indexerHttp,
      indexerWsEndpoint: indexerWs,
      proofServerEndpoint,
    });

    if (refId) {
      console.log(`Querying contract state for reference "${refId}"...`);
      const reference = await chain.readReference(refId);
      console.log('Reference found:');
      console.log(JSON.stringify(reference, null, 2));
    } else {
      console.log('\nNo reference ID provided — skipping chain read.');
    }

    console.log('\nDone.\n');
  } finally {
    rl.close();
    if (facade) {
      console.log('Shutting down wallet...');
      await Promise.race([
        facade.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => undefined);
    }
  }
}

// ── Masked input ───────────────────────────────────────────────────────────────

async function promptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const fallback = createInterface({ input, output });
    try {
      return (await fallback.question(prompt)).trim();
    } finally {
      fallback.close();
    }
  }

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const out = process.stdout;

    out.write(prompt);

    let value = '';

    const onData = (chunk: Buffer): void => {
      const str = chunk.toString('utf8');

      if (str === '\r' || str === '\n') {
        cleanup();
        out.write('\n');
        resolve(value);
        return;
      }

      if (str === '\u0003') {
        cleanup();
        reject(new Error('Input cancelled.'));
        return;
      }

      if (str === '\u007f' || str === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          out.write('\b \b');
        }
        return;
      }

      value += str;
      out.write('*'.repeat(str.length));
    };

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// ── Entry ──────────────────────────────────────────────────────────────────────

main()
  .then(() => { process.exit(0); })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[Midnight Console Demo] ${message}\n`);
    process.exit(1);
  });
