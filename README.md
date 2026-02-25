# dStorage SDK

> Privacy-first data layer for dApps — client-side encryption + decentralised storage + on-chain coordination in a single SDK.

## What it does

Instead of dApps collecting and storing user data on centralised servers, dStorage shifts data ownership to the user:

- **Encrypts** data client-side using wallet-derived keys (AES-GCM 256)
- **Pays** storage and chain networks using their native tokens (AR, ANT, DUST, ETH…)
- **Stores** encrypted blobs on decentralised storage (Arweave, Autonomi)
- **Writes** cryptographic references on-chain (Midnight, EVM chains)
- **Decrypts** locally — the application never sees raw user data

Privacy becomes an **architectural guarantee**, not a compliance promise.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run the demo app
npm run dev -w apps/demo

Note: Any time you modify packages/crypto or packages/chain, run `npm run build` (or per-package build) before running the demo, since the console app now uses the compiled dist files:
npm run build --workspace=@dstorage/crypto
npm run build --workspace=@dstorage/chain

# 3. Run Midnight-only console demo (no storage integration)
npm run demo:midnight
```

Open http://localhost:5173 — connect a wallet (or use Demo Mode) and try the full flow.

For terminal-only testing, `npm run demo:midnight` starts a CLI that:
- asks for a passphrase and derives deterministic key material
- initializes the SDK's `MidnightChainAdapter` only
- does not configure or call any storage adapter

---

## SDK Usage (3 lines to get started)

```typescript
import {
  DStorage,
  MockStorageAdapter,
  MockChainAdapter,
  connectMetaMask,
} from '@dstorage/core';

// 1. Init SDK with your chosen providers
const ds = new DStorage({
  storageAdapter: new MockStorageAdapter(),   // swap for ArweaveStorageAdapter
  chainAdapter:   new MockChainAdapter(),     // swap for MidnightChainAdapter
});

// 2. Connect wallet (derives encryption key from signature)
const walletInfo = await connectMetaMask();
await ds.connect(walletInfo);

// 3. Encrypt, store, and get an on-chain reference in one call
const { dataId } = await ds.upload("Hello, private world!");

// 4. Retrieve and decrypt
const { content } = await ds.retrieve(dataId);
console.log(content); // "Hello, private world!"

// 5. Grant selective access to another wallet
await ds.grant(dataId, "0xRecipientAddress");

// 6. Revoke access
await ds.revoke(dataId, "0xRecipientAddress");
```

---

## Payments

Every upload involves two real costs — paying the storage network to hold your data and paying the chain network to record the reference. The SDK handles both transparently.

### How it works

```typescript
// Estimate costs before committing
const estimate = await ds.estimateCost(file);
// → { storageCost: { amount: '0.000123', token: 'AR', usd: '0.003' },
//     chainCost:   { amount: '1.5',      token: 'DUST', usd: '0.002' },
//     totalUsd: '0.005' }

// Execute the full meta-transaction (encrypt → pay storage → upload → pay chain → write reference)
const receipt = await ds.executeMetaTransaction(file, (progress) => {
  console.log(progress.currentStepId); // 'estimate' | 'encrypt' | 'payment_storage' | 'upload' | 'payment_chain' | 'chain_reference' | 'complete'
});

console.log(receipt.totalUsd);         // Total cost in USD
console.log(receipt.storagePayment);   // Payment receipt for storage
console.log(receipt.chainPayment);     // Payment receipt for chain tx
```

### Supported tokens

| Token | Network | Used for |
|-------|---------|----------|
| `AR` | Arweave | Storage — permanent, pay once |
| `ANT` | Autonomi | Storage — permanent, pay once |
| `DUST` | Midnight | Chain tx fees |
| `ETH` | Ethereum | Chain tx fees |
| `MATIC` | Polygon | Chain tx fees |
| `MOCK` | Mock | Development & testing (no real cost) |

Tokens are selected automatically based on your chosen adapters, or you can override them explicitly:

```typescript
await ds.executeMetaTransaction(file, onProgress, {
  storageToken: 'AR',
  chainToken: 'DUST',
});
```

### Pricing model

- **Arweave**: ~$0.004/MB — real cost fetched from Arweave pricing API
- **Autonomi**: ~$0.001/MB — one-time ANT payment for permanent storage
- **Midnight**: ~$0.01 per tx — DUST fee via `createBalancedTx`
- **EVM**: ~$2 per tx — gas estimate (planned Sprint 3)

---

## Architecture

```
@dstorage/core          ← Developer-facing API (this is what you import)
    ├── @dstorage/crypto    ← AES-GCM encryption, wallet key derivation
    ├── @dstorage/storage   ← Storage adapters: Mock | Arweave | Autonomi
    ├── @dstorage/chain     ← Chain adapters:   Mock | Midnight | (EVM coming)
    └── @dstorage/payment   ← Cost estimation + payment abstraction (AR, ANT, DUST, ETH…)
```

### Data Flow

```
User input
    │
    ▼
[encrypt]      ← AES-GCM key derived from wallet signature
    │              (key never leaves the device)
    ▼
[pay storage]  → AR / ANT / MOCK — wallet prompt + confirmation
    │
    ▼
[store]        → Encrypted blob → Arweave / Autonomi / Mock
    │
    ▼
[pay chain]    → DUST / ETH / MOCK — wallet prompt + confirmation
    │
    ▼
[reference]    → Storage pointer + owner → Midnight / Mock chain
    │              (owner hidden behind ZK proof on Midnight)
    ▼
 dataId        ← "<storageId>::<chainRefId>"
 private state ← owner's on-chain record updated (ZK-shielded, not publicly readable)
```

---

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| `@dstorage/crypto` | Key derivation + AES-GCM encrypt/decrypt | 🚧 In Progress |
| `@dstorage/storage` | Storage adapter interface + adapters | 🚧 In Progress |
| `@dstorage/chain` | Chain adapter interface + adapters | 🚧 In Progress |
| `@dstorage/core` | Orchestration SDK + wallet helpers | 🚧 In Progress |

---

## Supported Providers

### Storage
| Provider | Status | Notes |
|----------|--------|-------|
| Mock (localStorage) | ✅ Live | Perfect for development & demos |
| Arweave | 🟡 Preview | Requires `arweave` package + ArConnect wallet |
| Autonomi | 🔵 Stub | Awaiting Autonomi JS SDK stability |

### Blockchain
| Chain | Status | Notes |
|-------|--------|-------|
| Mock | ✅ Live | Simulates on-chain references locally |
| Midnight | 🟡 Preview | Awaiting Midnight.js v1 |
| EVM chains | 🗓 Planned | Sprint N |

---

## Roadmap

- **Sprint 0** — Foundation, crypto, mock adapters, demo app ✅
- **Sprint 1** — Arweave live integration, Midnight preprod, permissions
- **Sprint 2** — Node.js isomorphic support, payment abstraction
- **Sprint 3** — Cross-dApp portability, EVM adapter
- **Sprint 4** — Docs site, sandbox, token conversion gateway
- **Sprint 5** — Public npm launch, partner integrations
