/**
 * dStorage Midnight Console Demo
 *
 * A real working CLI that:
 *  1. Accepts a BIP-39 mnemonic (or 32/64-byte hex seed)
 *  2. Accepts an (optional) deployed DataRegistry contract address
 *  3. Initialises the DStorage SDK — which internally:
 *       a. Derives keys, builds WalletFacade, and waits for sync
 *       b. Deploys a new DataRegistry if no address was given (requires ZK artifacts)
 *       c. Derives an AES-GCM encryption key from the seed
 *  4. Displays wallet addresses and balances
 *  5. Upload loop: asks for a local file path, reads its contents, calls
 *       sdk.upload(content) → encrypt → mock-store → write on-chain reference
 *     and prints the refId returned by the DataRegistry circuit
 *
 * Prerequisite: run `npm run compile:contract` from packages/chain to build the
 * DataRegistry ZK artifacts before using this demo.
 */

// ── WebSocket polyfill ────────────────────────────────────────────────────────
// The Midnight indexer uses GraphQL subscriptions over WebSocket.
// Node.js doesn't expose a global WebSocket; the `ws` package fills this gap.
import WebSocket from 'ws';
// @ts-expect-error — ws type doesn't perfectly match the DOM WebSocket interface
globalThis.WebSocket = WebSocket;

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DStorage } from '@dstorage/core';
import { MockStorageAdapter } from '@dstorage/storage';
import { MidnightChainAdapter } from '@dstorage/chain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ZK artifacts for the DataRegistry contract.
// Built by running: npm run compile:contract (from packages/chain)
// Resolves to: <monorepo-root>/packages/chain/src/adapters/midnight/contracts/managed/contract/
const DATA_REGISTRY_ZK_PATH = path.resolve(
  __dirname,
  '../../../packages/chain/src/adapters/midnight/contracts/managed/contract'
);

// ── Network defaults ───────────────────────────────────────────────────────────

const NETWORKS = {
  preprod: {
    node: 'wss://rpc.preprod.midnight.network',
    indexerHttp: 'https://indexer.preprod.midnight.network/api/v3/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
    proofServer: 'http://127.0.0.1:6300',
  },
  undeployed: {
    node: 'ws://127.0.0.1:9944',
    indexerHttp: 'http://127.0.0.1:8088/api/v3/graphql',
    indexerWs: 'ws://127.0.0.1:8088/api/v3/graphql/ws',
    proofServer: 'http://127.0.0.1:6300',
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
  let rl = createInterface({ input, output });
  let chain: MidnightChainAdapter | undefined;

  try {
    console.log('\n=== dStorage Midnight Console Demo ===\n');

    // ── 1. Network selection ────────────────────────────────────────────────
    const networkInput =
      (await rl.question('Midnight network [preprod / undeployed, default: preprod]: ')).trim() ||
      'preprod';
    if (networkInput !== 'preprod' && networkInput !== 'undeployed') {
      throw new Error(`Unknown network "${networkInput}". Choose preprod or undeployed.`);
    }
    const networkName = networkInput as NetworkName;
    const defaults = NETWORKS[networkName];

    console.log(`Network: ${networkName}\n`);

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
    console.log('\nEnter BIP-39 mnemonic (12/24 words) or hex seed (64/128 chars).');
    rl.close();
    const seedInput = await promptSecret('Mnemonic / hex seed: ');
    rl = createInterface({ input, output });
    process.stdout.write('\n');
    if (!seedInput) throw new Error('Mnemonic or seed is required.');

    const trimmed = seedInput.trim();
    const isHex = /^[0-9a-fA-F]{64}$/.test(trimmed) || /^[0-9a-fA-F]{128}$/.test(trimmed);
    const credentials = isHex ? { seedHex: trimmed } : { mnemonic: trimmed };

    // ── 4. Contract address (optional) ──────────────────────────────────────
    const contractAddressInput = (
      await rl.question('\nDeployed DataRegistry contract address (leave blank to auto-deploy): ')
    ).trim();

    // ── 5. Build the chain adapter ──────────────────────────────────────────
    chain = new MidnightChainAdapter({
      network: networkName,
      credentials,
      ...(contractAddressInput ? { contractAddress: contractAddressInput } : {}),
      nodeEndpoint,
      indexerEndpoint: indexerHttp,
      indexerWsEndpoint: indexerWs,
      proofServerEndpoint,
      // ZK artifacts for the DataRegistry storeReference circuit
      zkArtifactsPath: DATA_REGISTRY_ZK_PATH,
    });
    const activeChain = chain;

    // ── 6. Initialise the DStorage SDK ──────────────────────────────────────
    // sdk.init() calls chain.init() (wallet sync), then sets/deploys the contract,
    // and derives an AES-GCM encryption key from the seed.
    const sdk = new DStorage({
      storageAdapter: new MockStorageAdapter(),
      chainAdapter: activeChain,
      ...(contractAddressInput ? { dataRegistryAddress: contractAddressInput } : {}),
    });

    console.log('\nInitialising wallet, syncing, and preparing contract...');
    const { dataRegistryAddress } = await withTicker(
      () => 'Building wallet and syncing...',
      () => sdk.init()
    );
    console.log(`\nContract:   ${dataRegistryAddress}`);

    // ── 7. Display addresses and balances ───────────────────────────────────
    const addresses = activeChain.getAddresses();
    console.log('\nWallet addresses:');
    console.log(`  Unshielded: ${addresses.unshielded}`);
    console.log(`  Shielded:   ${addresses.shielded}`);
    console.log(`  Dust:       ${addresses.dust}`);

    const balances = await activeChain.getBalances();
    if (balances.night === 0n) {
      console.log(`\nNo NIGHT tokens found. Send NIGHT to:\n  ${addresses.unshielded}`);
    } else {
      console.log(`\nNIGHT balance: ${balances.night}`);
    }
    if (balances.dust === 0n) {
      console.log('Warning: No DUST found. DUST is required for transaction fees.');
    } else {
      console.log(`DUST balance:  ${balances.dust}`);
    }

    // ── 8. File upload loop ─────────────────────────────────────────────────

    console.log('\n─── File upload ───────────────────────────────────────────────────────');
    console.log('The SDK will encrypt your file, store it (mock), and write a reference on-chain.\n');

    let done = false;
    while (!done) {
      const filePath = (await rl.question('File path to upload (or leave blank to quit): ')).trim();

      if (!filePath) {
        done = true;
        continue;
      }

      // Read file from disk
      let fileContent: Uint8Array;
      try {
        const buf = await readFile(filePath);
        fileContent = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Error reading file: ${msg}`);
        continue;
      }

      console.log(`\n  File: ${path.basename(filePath)} (${fileContent.byteLength} bytes)`);
      console.log('  Encrypting, uploading to mock storage, and writing on-chain reference...');

      try {
        const result = await withTicker(
          () => 'Generating ZK proof and submitting reference...',
          () => sdk.upload(fileContent)
        );

        console.log('\n  ✓ Upload complete!');
        console.log(`  refId:           ${result.refId}`);
        console.log(`  storageId:       ${result.storageId}`);
        console.log(`  storageProvider: ${result.storageProvider}`);
        console.log(`  chainProvider:   ${result.chainProvider}`);
        console.log(`  uploadedAt:      ${new Date(result.uploadedAt).toISOString()}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n  Error during upload: ${msg}\n`);
      }
    }

    console.log('\nDone.\n');
  } finally {
    rl.close();
    if (chain) {
      console.log('Shutting down wallet...');
      await chain.stop();
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
