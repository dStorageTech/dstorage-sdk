/**
 * dStorage Midnight Console Demo
 *
 * A real working CLI that:
 *  1. Accepts a BIP-39 mnemonic (or 32/64-byte hex seed)
 *  2. Initializes MidnightChainAdapter with credentials
 *  3. Calls chain.init() which derives keys, builds wallet, and syncs
 *  4. Displays wallet addresses and balances
 *  5. Reads a Counter contract reference via MidnightChainAdapter
 */

// ── WebSocket polyfill ────────────────────────────────────────────────────────
// The Midnight indexer uses GraphQL subscriptions over WebSocket.
// Node.js doesn't expose a global WebSocket; the `ws` package fills this gap.
import WebSocket from 'ws';
// @ts-expect-error — ws type doesn't perfectly match the DOM WebSocket interface
globalThis.WebSocket = WebSocket;

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { MidnightChainAdapter } from '@dstorage/chain';
import { ContractState } from '@midnight-ntwrk/compact-runtime';

// ── Compiled contract ─────────────────────────────────────────────────────────
// Loaded from the compactc-generated output. Run `npm run compile:contract` first.
// Using a dynamic import so missing output causes a clear runtime error rather
// than a build failure.
// The full module is imported (not just the Contract class) so that listReferences()
// can use the module's ledger() function to decode on-chain state.
let compiledCounter: object | null = null;
try {
  // @ts-ignore — file only exists after running compile:contract
  const managed = await import('../contracts/managed/todoList/contract/index.js');
  // Pass the full module (has Contract class + ledger() decoder + pureCircuits).
  compiledCounter = (typeof managed === 'object' && managed !== null) ? managed : null;
} catch (err) {
  // Will be handled in main() with a user-friendly message.
  // Log here so import failures (e.g. missing @midnight-ntwrk/compact-runtime) are visible.
  console.error('[dStorage] Failed to load compiled contract:', err);
}

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

// ── Ledger value formatter ─────────────────────────────────────────────────────
// Converts raw decoded ledger values into human-readable strings.
// Handles bigint, boolean, Uint8Array, iterable Maps, and plain objects.

function formatLedgerValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '(null)';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value.toString();
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');

  if (typeof value === 'object') {
    // Iterable (Map-like) — show size and first few entries
    const iter = (value as Record<symbol, unknown>)[Symbol.iterator];
    if (typeof iter === 'function') {
      const sizeFn = (value as Record<string, unknown>)['size'];
      const size = typeof sizeFn === 'function' ? (sizeFn as () => bigint)() : '?';
      if (depth > 0) return `Map(${size})`;
      const entries: string[] = [];
      for (const entry of value as Iterable<unknown>) {
        if (entries.length >= 3) { entries.push('…'); break; }
        if (Array.isArray(entry) && entry.length === 2) {
          const k = formatLedgerValue(entry[0], depth + 1);
          const v = formatLedgerValue(entry[1], depth + 1);
          entries.push(`${k} → ${v}`);
        } else {
          entries.push(formatLedgerValue(entry, depth + 1));
        }
      }
      return `Map(${size}) { ${entries.join(', ')} }`;
    }
    // Plain object — show key: value pairs
    const pairs = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${formatLedgerValue(v, depth + 1)}`
    );
    return `{ ${pairs.join(', ')} }`;
  }

  return String(value);
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

    // ── 4. Compiled contract check ──────────────────────────────────────────
    if (!compiledCounter) {
      throw new Error(
        'Compiled contract not found.\n' +
        '  Run: npm run compile:contract\n' +
        '  Then restart the demo.'
      );
    }

    const contractAddress = (
      await rl.question('\nDeployed contract address: ')
    ).trim();
    if (!contractAddress) {
      throw new Error('A contract address is required.');
    }

    chain = new MidnightChainAdapter({
      network: networkName,
      credentials,
      contractAddress,
      compiledContract: compiledCounter,
      nodeEndpoint,
      indexerEndpoint: indexerHttp,
      indexerWsEndpoint: indexerWs,
      proofServerEndpoint,
      stateDecoder: (hexState) =>
        ContractState.deserialize(Buffer.from(hexState, 'hex')).data,
    });

    // ── 5. Init (derives keys, builds wallet, waits for sync) ────────────────
    console.log('\nInitialising wallet and syncing...');
    const addresses = await withTicker(
      () => 'Building wallet and syncing...',
      () => chain.init()
    );
    console.log('Wallet synced.');

    console.log('\nWallet addresses:');
    console.log(`  Unshielded: ${addresses.unshielded}`);
    console.log(`  Shielded:   ${addresses.shielded}`);
    console.log(`  Dust:       ${addresses.dust}`);

    // ── 6. Balances ──────────────────────────────────────────────────────────
    const balances = await chain.getBalances();
    if (balances.night === 0n) {
      console.log(`\nNo NIGHT tokens found. Send NIGHT to:\n  ${addresses.unshielded}`);
    } else {
      console.log(`\nNIGHT balance: ${balances.night}`);
    }
    if (balances.dust === 0n) {
      console.log('Warning: No DUST found. DUST is required for transaction fees.');
    } else {
      console.log(`DUST balance: ${balances.dust}`);
    }

    // ── 7. Contract interaction ─────────────────────────────────────────────

    const ledgerEntry = (
      await rl.question('Ledger entry name to read (e.g. "round" for the counter contract): ')
    ).trim();
    if (!ledgerEntry) {
      throw new Error('A ledger entry name is required.');
    }

    console.log('\n─── Contract ledger ────────────────────────────────────────────────────');

    // Action menu loop
    let done = false;
    while (!done) {
      console.log(`\nReading ledger entry "${ledgerEntry}"...`);
      try {
        const value = await withTicker(
          () => 'Querying indexer...',
          () => chain.readLedgerEntry(ledgerEntry)
        );
        console.log(`${ledgerEntry} = ${formatLedgerValue(value)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(msg);
      }

      console.log('\nWhat would you like to do?');
      console.log('  [r] Read again (refresh)');
      console.log('  [q] Quit');

      const choice = (await rl.question('Choice: ')).trim().toLowerCase();
      if (choice === 'q' || choice === '') {
        done = true;
      } else if (choice !== 'r') {
        console.log('Unknown choice. Enter r or q.');
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
