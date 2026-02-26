# Arweave Local Testing Guide

> **TL;DR:** Real Arweave has no public free testnet — use **arlocal**, a zero-config local Arweave sandbox with instant token minting and no real AR required.

---

## Why arlocal, not arweave.dev?

Arweave does not maintain a traditional testnet the way EVM chains do. The
`arweave.dev` gateway currently redirects to mainnet — uploading data there
costs real AR. For development and CI you need a local sandbox instead.

**arlocal** ([github.com/textury/arlocal](https://github.com/textury/arlocal))
is the standard solution:

| Feature | arlocal (local) | arweave.net (mainnet) |
|---|---|---|
| AR tokens required | ❌ — mint instantly | ✅ — must purchase |
| Confirmation time | instant (mine on demand) | 2–20 minutes |
| Data persists | ❌ (resets on restart) | ✅ forever |
| Works offline | ✅ | ❌ |
| Safe for CI | ✅ | ❌ |

---

## 1. Install dependencies

```bash
# Required peer dep — arweave-js for signing transactions
npm install arweave

# arlocal — dev dep only, not needed in production
npm install --save-dev arlocal
```

---

## 2. Start arlocal

```bash
# Start on the default port (1984)
npx arlocal

# Start on a custom port
npx arlocal --port 1985

# Start with persistent storage (survives restarts)
npx arlocal --persist
```

You should see:
```
arlocal started on port 1984
```

Leave it running in a terminal tab while you develop. For CI, add it to your
test startup script (see [CI setup](#ci-setup) below).

---

## 3. Generate a test wallet

You need a wallet to sign transactions. Generate one programmatically — no
registration, no account, just a fresh cryptographic key pair:

```typescript
import Arweave from 'arweave';

const arweave   = Arweave.init({ host: 'localhost', port: 1984, protocol: 'http' });
const walletKey = await arweave.wallets.generate(); // returns a JWK object
const address   = await arweave.wallets.jwkToAddress(walletKey);

console.log('Wallet address:', address);
console.log('Save walletKey to a file for reuse, or regenerate each test run.');
```

> ⚠️ **Never use a real Arweave wallet for local testing** — and never commit
> `wallet.json` to version control. Always `.gitignore` it.

---

## 4. Mint test tokens

arlocal exposes a `/mint` endpoint that credits any wallet instantly:

```typescript
import { ArweaveLocalHelper } from '@dstorage/storage';
// or: import { ArweaveLocalHelper } from '@dstorage/core';

const helper = new ArweaveLocalHelper(); // defaults to localhost:1984

// Mint 10 AR into the wallet (1 AR = 1_000_000_000_000 Winstons)
await helper.mintTokens(address, 10_000_000_000_000n);

// Check the balance
const { ar, winstons } = await helper.getBalance(address);
console.log(`Balance: ${ar} AR (${winstons} winstons)`);
```

There is no daily limit, captcha, or API key — mint as much as you need.

---

## 5. Use `ArweaveLocalStorageAdapter`

`ArweaveLocalStorageAdapter` is a dedicated testnet adapter that:
- Pre-configures the gateway to `localhost:1984`
- Extends `ArweaveStorageAdapter` with an identical API
- Exposes a `.testnet` helper for minting, mining, and balance checks

### Option A — Static factory (recommended)

The `createWithTestWallet()` factory handles steps 3 and 4 for you:

```typescript
import { ArweaveLocalStorageAdapter, MockChainAdapter } from '@dstorage/core';
import { DStorage } from '@dstorage/core';

// Generates a wallet, mints 10 AR, returns a ready adapter
const { adapter, walletKey, address } =
  await ArweaveLocalStorageAdapter.createWithTestWallet();

// Fund more if needed
await adapter.testnet.mintTokens(address, 5_000_000_000_000n); // +5 AR

// Plug in exactly where you'd use ArweaveStorageAdapter
const ds = new DStorage({
  storageAdapter: adapter,
  chainAdapter:   new MockChainAdapter(),
});
```

### Option B — Manual config

```typescript
import Arweave from 'arweave';
import {
  ArweaveLocalStorageAdapter,
  ArweaveLocalHelper,
  ARWEAVE_LOCAL,
} from '@dstorage/core';

// 1. Generate wallet
const arweave   = Arweave.init(ARWEAVE_LOCAL);
const walletKey = await arweave.wallets.generate();
const address   = await arweave.wallets.jwkToAddress(walletKey);

// 2. Create adapter
const adapter = new ArweaveLocalStorageAdapter({ walletKey });

// 3. Mint tokens via the embedded helper
await adapter.testnet.mintTokens(address, 10_000_000_000_000n); // 10 AR

// 4. Use it
const ds = new DStorage({
  storageAdapter: adapter,
  chainAdapter:   new MockChainAdapter(),
});
```

---

## 6. Upload and retrieve

The API is identical to the mainnet adapter:

```typescript
import { connectDemoWallet } from '@dstorage/core';

const walletInfo = await connectDemoWallet('0xTestUser');
await ds.connect(walletInfo);

// Upload — sends an Arweave tx to arlocal (no real AR spent)
const { id } = await ds.upload('My private test data');
console.log('TX ID:', id);
// → [dStorage/arweave-local] ⚠️  Testnet upload — data is NOT on the real Arweave network.
// → [dStorage/arweave-local] Mine a block to confirm: adapter.testnet.mine()

// Mine a block to "confirm" the transaction
await adapter.testnet.mine();

// Retrieve — fetches and decrypts locally
const { content } = await ds.retrieve(id);
console.log(content); // "My private test data"
```

---

## 7. Confirm transactions

By default, `ArweaveStorageAdapter` (and the local adapter) return as soon as
arlocal accepts the transaction (HTTP 202, "pending"). If you need the
transaction to appear as confirmed — for example to test `waitForConfirmation`
mode — mine a block first:

```typescript
// Upload without waiting
const { id } = await adapter.upload(data);

// Mine one block — transaction is now "confirmed" in arlocal
await adapter.testnet.mine();

// Now check status (should be 200)
const status = await arweave.transactions.getStatus(id);
console.log(status.status); // 200

// Or use waitForConfirmation with a short poll interval:
const confirmingAdapter = new ArweaveLocalStorageAdapter({
  walletKey,
  waitForConfirmation:   true,
  confirmationPollMs:    200,  // poll every 200ms
  confirmationTimeoutMs: 5_000,
});
// In parallel, mine a block so polling finds it confirmed:
setTimeout(() => adapter.testnet.mine(), 300);
const result = await confirmingAdapter.upload(data);
```

---

## 8. Custom gateway port

```typescript
import { ArweaveLocalStorageAdapter, arlocalGateway } from '@dstorage/core';

// arlocal running on port 1985
const adapter = new ArweaveLocalStorageAdapter({
  walletKey,
  gateway: arlocalGateway(1985),
});
```

---

## 9. Check if arlocal is running

Use `isRunning()` to gate your tests gracefully instead of failing with a
cryptic connection error:

```typescript
const helper = new ArweaveLocalHelper();

if (!(await helper.isRunning())) {
  console.warn('⚠️  arlocal is not running — start it with: npx arlocal');
  process.exit(1);
}
```

---

## 10. Reset state between tests

```typescript
afterEach(async () => {
  await adapter.testnet.reset(); // wipes all transactions
});
```

---

## CI setup

Add arlocal as a background process in your CI pipeline:

### GitHub Actions

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: Install dependencies
        run: npm ci

      - name: Start arlocal
        run: npx arlocal &
        # Give it a moment to boot
      - run: sleep 2

      - name: Run tests
        run: npm test
```

### Or use vitest globalSetup

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/setup-arlocal.ts',
  },
});
```

```typescript
// test/setup-arlocal.ts
import { ArweaveLocalHelper } from '@dstorage/storage';

export async function setup() {
  const helper = new ArweaveLocalHelper();
  if (!(await helper.isRunning())) {
    throw new Error('arlocal must be running before tests. Run: npx arlocal');
  }
}
```

---

## Switching from testnet → mainnet

One line change:

```typescript
// Testnet (local arlocal)
storageAdapter: new ArweaveLocalStorageAdapter({ walletKey: testJwk })

// Mainnet (real Arweave — needs real AR tokens)
storageAdapter: new ArweaveStorageAdapter({ walletKey: realJwk })
```

Everything else — `DStorage`, `ds.upload()`, `ds.retrieve()`, `ds.grant()` —
stays identical.

---

## API reference

### `ArweaveLocalStorageAdapter`

Extends `ArweaveStorageAdapter`. Same upload / retrieve / estimateCost API.

| Config | Type | Default | Description |
|---|---|---|---|
| `walletKey` | `Record<string,string>` | — | JWK wallet key for signing |
| `gateway` | `ArweaveGatewayConfig` | `ARWEAVE_LOCAL` | Override arlocal host/port |
| `maxRetries` | `number` | `3` | Retries on failed tx post |
| `waitForConfirmation` | `boolean` | `false` | Block until tx confirmed |
| `confirmationPollMs` | `number` | `30_000` | Polling interval (ms) |
| `confirmationTimeoutMs` | `number` | `1_200_000` | Confirmation timeout (ms) |

**Static factory:**

```typescript
const { adapter, walletKey, address } =
  await ArweaveLocalStorageAdapter.createWithTestWallet({
    fundAr:  10,          // AR to mint into the wallet
    gateway: ARWEAVE_LOCAL, // override arlocal URL
  });
```

### `ArweaveLocalHelper`

| Method | Returns | Description |
|---|---|---|
| `mintTokens(address, winstons?)` | `Promise<void>` | Credit a wallet. Default: 1 AR |
| `mine(blocks?)` | `Promise<void>` | Fast-forward `n` blocks. Default: 1 |
| `getBalance(address)` | `Promise<{ ar, winstons }>` | Query wallet balance |
| `getInfo()` | `Promise<ArweaveLocalInfo>` | Node info (height, network, …) |
| `isRunning()` | `Promise<boolean>` | Check if arlocal is reachable |
| `reset()` | `Promise<void>` | Wipe all transactions |

### Gateway presets

```typescript
import { ARWEAVE_MAINNET, ARWEAVE_LOCAL, arlocalGateway } from '@dstorage/core';

ARWEAVE_MAINNET  // { host: 'arweave.net',  port: 443,  protocol: 'https' }
ARWEAVE_LOCAL    // { host: 'localhost',     port: 1984, protocol: 'http'  }
arlocalGateway(1985) // { host: 'localhost', port: 1985, protocol: 'http'  }
```
