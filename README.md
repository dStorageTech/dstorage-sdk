# dStorage SDK

> Privacy-first data layer for dApps — client-side encryption + decentralised storage + on-chain coordination in a single SDK.

## 🎯 Vision

Deliver a **privacy-first, developer-friendly data layer** combining **Midnight privacy infrastructure** with **permanent decentralized storage**, enabling applications to handle sensitive user data securely **without centralized custody**.

## What it does

Instead of dApps collecting and storing user data on centralised servers, dStorage shifts data ownership to the user:

- **Encrypts** data client-side using wallet-derived keys (AES-GCM 256)
- **Pays** storage and chain networks using adapter-defined tokens (MOCK, AR, DUST)
- **Stores** encrypted blobs on decentralised storage (Arweave, Autonomi)
- **Writes** cryptographic references on-chain (Mock, Midnight)
- **Decrypts** locally — the application never sees raw user data

Privacy becomes an **architectural guarantee**, not a compliance promise.

Most applications store user data on servers they control. That means users have to trust that the service provider won't read, sell, or lose their data — and history shows that trust is often misplaced. dStorage takes a different approach: data is encrypted on the user's device before it ever leaves, stored on a decentralised network where no single party has control, and a tamper-proof on-chain record ties the data back to its owner. The service provider never sees the plaintext. Neither does anyone else.

The way it works is straightforward. When a user uploads something, the SDK encrypts it locally using a key derived from their wallet — a key that only they can regenerate. The encrypted blob goes to a storage network (Arweave, Arweave Local, or a mock for development). A lightweight reference — just a storage ID and the owner's address — is then written to a blockchain, giving the owner a verifiable receipt. To retrieve the data, the process runs in reverse: look up the reference on-chain, fetch the blob, decrypt it locally. At no point does any server hold an unencrypted copy.

For developers, the SDK is designed to get out of the way. You configure it once with the storage and chain backends that fit your stack, connect a wallet, and call `upload` and `retrieve` (or `retrieveByRefId`). You can start entirely with in-memory mocks (no network, no tokens, no wallet extension), and swap in network-backed adapters when you are ready. If you are building on Midnight, the SDK supports wallet lifecycle management, contract deployment/join, reference listing/lookups, and fee handling in adapter flows.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run the demo app
npm run dev -w apps/demo
```

Note: Any time you modify `packages/crypto` or `packages/chain`, run `npm run build` (or per-package build) before running the demo, since the demo app consumes compiled package outputs:

```bash
npm run build --workspace=@dstorage/crypto
npm run build --workspace=@dstorage/chain

# 3. Run Midnight console demo
npm run demo:midnight
```

Open http://localhost:5173 and choose a path:
- upload a new health insurance certificate
- or jump directly to proof generation from a mock list of previously uploaded certificates

For terminal-only testing, `npm run demo:midnight` starts a CLI that:
- asks for network + wallet seed/mnemonic and initializes `MidnightChainAdapter`
- uses Arweave Local storage in the current CLI implementation
- provides actions to upload files, list on-chain references, and retrieve content by `refId`

---

## Documentation

- **[Getting Started Guide](docs/getting-started.md)** — Adapters explained, supported flows, and code examples for every use case

---

## SDK Usage

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

// 5. Retrieve by on-chain reference ID
const { content: byRef } = await ds.retrieveByRefId("your-ref-id");
console.log(byRef);
```

---

## Payments

Every upload involves two costs — paying storage and chain operations. The SDK orchestrates this through pluggable payment adapters. Depending on adapter choice, payments can be simulated (mock/preview) or real.

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
| `AR` | Arweave | Storage payment adapter (preview/simulated mode) |
| `DUST` | Midnight | Chain payment adapter (preview/simulated mode) |
| `MOCK` | Mock | Development & testing (simulated) |
| `ANT` / `ETH` / `MATIC` | Token registry | Defined token metadata for future/override use |

Tokens are selected automatically based on your chosen adapters, or you can override them explicitly:

```typescript
await ds.executeMetaTransaction(file, onProgress, {
  storageToken: 'AR',
  chainToken: 'DUST',
});
```

### Pricing model (current adapters)

- **MockPaymentAdapter**: simulated values, no real transfers
- **ArweavePaymentAdapter**: preview pricing + simulated payment flow
- **MidnightPaymentAdapter**: preview pricing + simulated payment flow

---

## Architecture

```
@dstorage/core          ← Developer-facing API (this is what you import)
    ├── @dstorage/crypto    ← AES-GCM encryption, wallet key derivation
    ├── @dstorage/storage   ← Storage adapters: Mock | Arweave | Arweave Local | Autonomi(stub)
    ├── @dstorage/chain     ← Chain adapters:   Mock | MockMidnight | Midnight
    └── @dstorage/payment   ← Payment adapters: Mock | Arweave(preview) | Midnight(preview)
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
| Mock (localStorage/memory) | ✅ Live | Perfect for development & demos |
| Arweave Local | ✅ Live | Local arlocal integration testing |
| Arweave | 🟡 Preview | Requires `arweave` package + ArConnect wallet |
| Autonomi | 🔵 Stub | Awaiting Autonomi JS SDK stability |

### Blockchain
| Chain | Status | Notes |
|-------|--------|-------|
| Mock | ✅ Live | Simulates on-chain references locally |
| MockMidnight | ✅ Live | Simulated Midnight-like chain behavior |
| Midnight | ✅ Live | Connector + facade modes supported |

---

## High-Level Product Roadmap

**Primary Objective**

Ship a polished **v1 SDK** with:
- Production-grade security
- Clear developer onboarding
- Real developer adoption

---

### Roadmap Overview

| Phase | Focus | Outcome |
|------|------|------|
| 1 | Core Foundations | Stable architecture |
| 2 | Midnight Integration | Private on-chain coordination |
| 3 | Arweave Integration | Permanent encrypted storage |
| 4 | Developer Experience | Easy SDK adoption |
| 5 | Security & Validation | Production readiness |
| 6 | Launch & Growth | Market traction |

---

### Phase 1 — Core Foundations

**Goal:** Establish a stable and extensible architecture.

#### Key Deliverables

- Finalize SDK architecture and public APIs
- Stabilize core packages:
  - `@dstorage/core`
  - Crypto layer
  - Storage adapters
  - Chain adapters
- Implement client-side encryption
  - Wallet-derived keys
  - AES-GCM encryption
- Define adapter interface contracts
- Define smart contract for storing encrypted data references
- Deploy initial smart contract ledger
- Store encrypted data references linked to user contracts

#### Outcome

- ✅ Technical foundation locked  
- ✅ Future adapters enabled  
- ✅ Security model established early  

---

### Phase 2 — Midnight Integration (Priority)

**Goal:** Enable private, verifiable data coordination.

#### Key Deliverables

- Production-ready `MidnightChainAdapter`
- Transaction orchestration & fee handling (DUST)
- ZK-proof integration for private references
- Wallet construction & signing flows
- Wallet UX integration 
    - App connector API 
    - Browser wallet extensions (for example, Lace) 
- End-to-end testing on pre-production environments

#### Outcome

- ✅ Privacy differentiation established  
- ✅ On-chain coordination operational  
- ✅ First real network dependency validated  

---

### Phase 3 — Arweave Storage Integration (Priority)

**Goal:** Deliver permanent encrypted storage.

#### Key Deliverables

- `ArweaveStorageAdapter`
  - Cost estimation
  - Upload flows
  - Retrieval flows
- Wallet UX integration (ArConnect + direct wallet)
- Storage payment orchestration
- Chunking + retry logic for large datasets
- Write encrypted data references on Midnight chain

#### Outcome

- ✅ Full decentralized data pipeline operational  
- ✅ Predictable storage economics  
- ✅ Real-world scalability demonstrated  

---

### Phase 4 — Developer Experience & SDK Polish

**Goal:** Make adoption frictionless.

#### Key Deliverables

- Complete orchestration flow: 
    `Encrypt → Pay Storage → Upload → Pay Chain → Write Reference`
- Public SDK API stabilization
- Full TypeScript typings

##### Reference Applications
- Web demo (browser wallet flow)
- CLI demo (seed-derived wallet)

##### Developer Enablement
- Starter templates
- Quickstart documentation

#### Outcome

- ✅ Developers integrate in hours, not weeks  
- ✅ Clear usability signal  
- ✅ Adoption-ready SDK  

---

### Phase 5 — Security, Quality & Release Preparation

**Goal:** Achieve production-grade reliability.

#### Key Deliverables

- Expanded automated testing
  - Unit tests
  - Integration tests
- CI/CD pipelines for builds and releases

##### Security Review
- Threat modeling
- Dependency audits
- Crypto flow validation

##### Validation
- Feedback cycle with early developer partners

#### Outcome

- ✅ Reduced execution risk  
- ✅ External validation  
- ✅ Enterprise credibility foundation  

---

### Phase 6 — Launch & Go-To-Market

**Goal:** Transition from product to ecosystem.

#### Key Deliverables

- Public SDK release (`npm` packages)
- Versioned documentation site
- Demo application launch

##### Developer Onboarding
- Quickstart tutorial
- One-page security brief

##### Ecosystem Growth
- Webinars
- Sample integrations
- Pilot partnerships

##### Expansion Roadmap
- Additional storage adapters
- EVM ecosystem support

#### Outcome

- ✅ Market entry achieved  
- ✅ Early network effects initiated  
- ✅ Expansion path defined  

---

### Success Metrics (Post-Launch)

- Developer integrations initiated
- SDK downloads & GitHub activity
- Pilot partners onboarded
- Data stored via SDK
- Transaction volume generated

---

### Strategic Positioning

The **dStorage SDK** becomes:

- The privacy data layer for next-generation dApps
- A neutral infrastructure primitive
- A multi-chain, multi-storage abstraction layer

---

### End State

A **production-ready privacy SDK** positioned to become **core infrastructure** for decentralized applications handling sensitive data.
