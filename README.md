<img src="docs/dStorage-logo-image-monochrome.png" alt="dStorage logo" width="80" />

# dStorage SDK

> Privacy-first data layer for dApps — client-side encryption + decentralised storage + on-chain coordination in a single SDK.

For teams building privacy-sensitive dApps (health, identity, finance, and enterprise workflows) that need strong client-side confidentiality without operating plaintext data infrastructure.

## Table of Contents

- [Vision](#vision)
- [What it does](#what-it-does)
- [Quick Start](#quick-start)
- [Testing](#testing)
- [Reality Check (Current Support)](#reality-check-current-support)
- [SDK Usage](#sdk-usage)
- [Payments](#payments)
- [Architecture](#architecture)
- [Supported Providers](#supported-providers)
- [Seed Providers](#seed-providers)
- [Known Limitations](#known-limitations)
- [High-Level Product Roadmap](#high-level-product-roadmap)

## Vision

Deliver a **privacy-first, developer-friendly data layer** combining **Midnight privacy infrastructure** with **permanent decentralized storage**, enabling applications to handle sensitive user data securely **without centralized custody**.

## What it does

Instead of dApps collecting and storing user data on centralised servers, dStorage shifts data ownership to the user:

- **Encrypts** data client-side using keys derived from a pluggable seed provider (password, wallet signature, mnemonic, or custom)
- **Pays** storage and chain networks using adapter-defined tokens (MOCK, AR, DUST)
- **Stores** encrypted blobs on decentralised storage (Arweave, Arweave Local, Mock, Autonomi)
- **Writes** cryptographic references on-chain (Mock, Midnight)
- **Decrypts** locally on the user side — dApp operators and backend servers never see raw user data

Privacy becomes an **architectural guarantee**, not a compliance promise.

Most applications store user data on servers they control. That means users have to trust that the service provider won't read, sell, or lose their data — and history shows that trust is often misplaced. dStorage takes a different approach: data is encrypted on the user's device before it ever leaves, stored on a decentralised network where no single party has control, and a tamper-proof on-chain record ties the data back to its owner. The service provider never sees the plaintext. Neither does anyone else.

The way it works is straightforward. When a user uploads something, the SDK encrypts it locally using a key derived from a seed provider — a key that only they can regenerate. The encrypted blob goes to a storage network (Arweave, Arweave Local, or a mock for development). A lightweight reference — just a storage ID — is then written to a blockchain, giving the owner a verifiable receipt. To retrieve the data, the process runs in reverse: look up the reference on-chain, fetch the blob/s, decrypt them locally. At no point does any server hold an unencrypted copy.

For developers, the SDK is designed to get out of the way. You configure it once with the storage and chain backends that fit your stack, call `init()`, and use `upload` and `retrieveByRefId`. You can start entirely with in-memory mocks (no network, no tokens, no wallet extension), and swap in network-backed adapters when you are ready. If you are building on Midnight, the SDK supports wallet lifecycle management, contract deployment/joining, reference listing/lookups, and fee handling in adapter flows.

---

## Quick Start

These setup steps are mainly for the current monorepo/development workflow and are temporary. Once the SDK is published as installable packages, most of the manual build and local wiring steps below will no longer be required for standard integration and usage.

### Prerequisites

- Node.js 22+ and npm (Download from [nodejs.org](nodejs.org))
- Docker for Midnight Proof server and Arweave local (Download from [docker.com/get-started](https://www.docker.com/get-started))
- Midnight [Compact developer tools](https://docs.midnight.network/blog/compact-developer-tools) — **version 0.30.0 required** (the ZK artifacts in this repository were built against that version)
- [Lace](https://www.lace.io) wallet extension (**version 1.36.2 or later**) for Midnight (browser connector flows)
- [Wander](https://www.wander.app) wallet extension for Arweave (browser connector flows)
- NIGHT test tokens for Midnight Preprod — request them from the [Midnight Preprod Faucet](https://faucet.preprod.midnight.network/)

### 1. Install Dependencies

Install dependencies for all packages:

```sh
npm install
```

### 2. Build the dStorage contract

The `DataRegistry` contract is the on-chain index used by the SDK. It records references to encrypted documents (for example `refId`, `storageId`, and related metadata) so proofs and lookups can resolve a reference to the underlying storage record. It does **not** store raw user files or plaintext data; payloads stay off-chain in the selected storage backend, while `DataRegistry` keeps the minimal verification and retrieval pointers on Midnight.

Install the Compact toolchain:

```sh
# Compact v0.30.0 matching the committed contract artifacts
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/download/v0.30.0/compact-installer.sh | sh
```

Compile the contract:

```sh
npm run compile:contract
```

### 3. Build the SDK adapters

Build the packages/adapters:

```bash
npm run build
```

Note: Any time you modify any of the packages, e.g. `packages/crypto` or `packages/chain`, run `npm run build` (or per-package build) before running any of the demo apps, since they consume compiled package outputs.

### 4. Run the Midnight proof server

Follow the Midnight [documentation to start the local proof server](https://docs.midnight.network/getting-started/installation#run-the-proof-server).

```sh
docker run -p 6300:6300 midnightntwrk/proof-server:8.0.3 -- midnight-proof-server -v
```

### 5. Run Arweave Local server

The console demo (`demo-console:run`) uses **Arweave Local** as its storage backend, so this step is required for it.

Start Arweave Local with Docker:

```sh
docker run -d --rm -p 1984:1984 textury/arlocal

# or run it with `npx`:
npx arlocal
```

The console demo also requires a local Arweave wallet key file at the app root.
This file (`apps/demo-console/test-arweave-wallet-key.json`) is used by `ArweaveLocalStorageAdapter` in the console demo. It is funded automatically by arlocal — no real AR tokens are needed. A test wallet file is already provided at this location, if you still want to generate a new one use the following NodeJs code:

```sh
# Generate a fresh wallet key (requires arweave-js):
node -e "
const Arweave = require('arweave');
const arweave = Arweave.init({});
arweave.wallets.generate().then(key => {
  require('fs').writeFileSync('apps/demo-console/test-arweave-wallet-key.json', JSON.stringify(key));
  console.log('Wallet key saved.');
});
"
```

### 6. Run any of the demo apps

Run the demo web app:

```bash
npm run demo:run
```

Open http://localhost:5173 and choose a path:

- upload a new health insurance certificate
- or jump directly to proof generation from a list of previously uploaded certificates

Alternatively, for terminal-only testing, run the console demo app:

```bash
npm run demo-console:run
```

It will start a CLI that:

- uses Midnight Preprod network and Arweave Local storage
- asks for network + wallet seed/mnemonic and initializes `MidnightChainAdapter`
- provides actions to upload files, list on-chain references, and retrieve content by `refId`

---

## Testing

### Unit tests

The unit test suite uses fully in-memory mocks (no network, no Docker). Run it with:

```sh
npm test
```

### Integration tests

Integration tests exercise real network adapters end-to-end:

- **arlocal-only suite** — `ArweaveLocalStorageAdapter` against a local arlocal node with `MockMidnightChainAdapter`
- **multi-key wrapping suite** — uploads encrypted with two seed providers verified against real arlocal storage; each provider independently decrypts and an unrelated provider is rejected
- **full-stack suite** — `ArweaveLocalStorageAdapter` + `MidnightChainAdapter` with ZK proofs against Midnight Preprod (or a local node); includes wallet-isolation test verifying that a different seed provider cannot decrypt another user's private references

#### Prerequisites

Start the required services:

```sh
# Arweave Local (required for both suites)
docker run -d --rm -p 1984:1984 textury/arlocal

# Midnight Proof Server (required for the full-stack suite)
docker run -d --rm -p 6300:6300 midnightntwrk/proof-server:8.0.3 -- midnight-proof-server -v
```

#### Configuration

Copy the example env file and fill in your values:

```sh
cp tests/integration/env.example .env.integration
```

The only required variable for the full-stack suite is `INTEGRATION_SEED` — a BIP-39 mnemonic or 64-char hex seed for a Midnight Preprod wallet funded with NIGHT and DUST tokens (see [Prerequisites](#prerequisites) for faucet links). All other variables have defaults that match the Docker commands above.

#### Run

```sh
set -a; source .env.integration; set +a
npm run test:integration
```

If a service is not running, its suite is **skipped** rather than failed — safe to run in CI environments where the services are unavailable. To reuse an already-deployed contract and skip the (slow) deployment step on subsequent runs, set `INTEGRATION_CONTRACT_ADDRESS` in `.env.integration` to the address printed on the first run.

#### Run a single test or suite

Use `-t` to filter by name (matches the `describe` label, the `it` label, or any prefix of the full name):

```sh
# Run only the arlocal-only suite
npm run test:integration -- -t "arlocal only"

# Run only the multi-key wrapping suite
npm run test:integration -- -t "multi-key wrapping"

# Run only the full-stack Midnight suite
npm run test:integration -- -t "full stack"

# Run a single test by name
npm run test:integration -- -t "uploads and retrieves private data"
```

---

## Reality Check (Current Support)

| Area             | Current state                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Storage adapters | `Mock` and `ArweaveLocal` are live; `Arweave` is preview; `Autonomi` is stub                         |
| Chain adapters   | `Mock`, `MockMidnight`, and `Midnight` are implemented                                               |
| Payment adapters | `Mock` is simulated by design; `Arweave` and `Midnight` payment adapters are preview/simulated flows |
| Demo webapp      | End-to-end upload UX; supports mock, browser Midnight connector and Arweave Local paths              |
| Console demo     | Uses Midnight Preprod chain + local Arweave flow for upload/list/retrieve operations                 |

---

---

## SDK Usage

```typescript
import { DStorage, MockStorageAdapter, MockChainAdapter } from "@dstorage/core";
import { PasswordSeedProvider } from "@dstorage/seed-providers";

// 1. Configure the SDK with your chosen adapters and an encryption seed provider
const sdk = new DStorage({
  storageAdapter: new MockStorageAdapter(), // swap for ArweaveStorageAdapter, ArweaveLocalStorageAdapter, etc.
  chainAdapter: new MockChainAdapter(), // swap for MidnightChainAdapter
  encryptionSeedProvider: new PasswordSeedProvider({
    password: "correct-horse-battery-staple",
    salt: "myapp:v1:alice@example.com", // app + user identifier — store this alongside your data
  }),
  // or: new MnemonicSeedProvider({ mnemonic: "..." })
});

// 2. Init — derives the encryption key and prepares the chain contract
await sdk.init();

// 3. Encrypt, store, and write an on-chain reference in one call
const { chainRefId, storageId } = await sdk.upload(
  new TextEncoder().encode("Hello, private world!"),
);

// 4. Retrieve and decrypt by on-chain reference ID
const { bytes } = await sdk.retrieveByRefId(chainRefId);
console.log(new TextDecoder().decode(bytes)); // "Hello, private world!"

// 5. Or retrieve directly by storage ID
const { bytes: direct } = await sdk.retrieveByStorageId(storageId);
console.log(new TextDecoder().decode(direct)); // "Hello, private world!"
```

---

## Payments

Every upload involves two costs — paying storage and chain operations. The SDK orchestrates this through pluggable payment adapters. Depending on adapter choice, payments can be simulated (mock/preview) or real.

### How it works

```typescript
// Estimate costs before committing
const estimate = await sdk.estimateCost(
  new TextEncoder().encode("example payload"),
);
// -> returns a human-readable estimate string for the configured storage adapter

// Execute the full meta-transaction (estimate → encrypt → pay storage → upload → write reference)
const receipt = await sdk.executeMetaTransaction(file, (progress) => {
  console.log(progress.currentStepId); // 'estimate' | 'encrypt' | 'payment_storage' | 'upload' | 'chain_reference' | 'complete'
});

console.log(receipt.storagePayment); // Payment receipt for storage
console.log(receipt.chainPayment); // Payment receipt for chain tx
console.log(receipt.chainRefId); // On-chain reference ID
```

### Supported tokens

| Token                   | Network        | Used for                                         |
| ----------------------- | -------------- | ------------------------------------------------ |
| `AR`                    | Arweave        | Storage payment adapter (preview/simulated mode) |
| `DUST`                  | Midnight       | Chain payment adapter (preview/simulated mode)   |
| `MOCK`                  | Mock           | Development & testing (simulated)                |

Tokens are selected automatically based on your chosen adapters.

---

## Architecture

```
@dstorage/core              ← Developer-facing API (this is what you import)
    ├── @dstorage/crypto        ← XChaCha20-Poly1305 encryption, key derivation
    ├── @dstorage/seed-providers← Seed providers: PasswordSeedProvider | MnemonicSeedProvider
    ├── @dstorage/storage       ← Storage adapters: Mock | Arweave | ArweaveTurbo | Arweave Local | Autonomi(stub)
    ├── @dstorage/chain         ← Chain adapters:   Mock | MockMidnight | Midnight
    └── @dstorage/payment       ← Payment adapters: Mock | Arweave | Managed
```

### Data Flow

```
User input
    │
    ▼
[encrypt]      ← key derived from seed provider (password, wallet, mnemonic…)
    │              (key never leaves the device)
    ▼
[pay storage]  → adapter-defined token (commonly AR / MOCK)
    │
    ▼
[store]        → Encrypted blob → Arweave / Arweave Local / Mock / Autonomi(stub)
    │
    ▼
[pay chain]    → adapter-defined token (commonly DUST / MOCK)
    │
    ▼
[reference]    → Storage pointer + owner → Midnight / Mock chain
    │              (owner hidden behind ZK proof on Midnight)
    ▼
 chainRefId    ← on-chain reference ID (use to retrieve later)
 storageId     ← storage network content ID
 private state ← owner's on-chain record updated (ZK-shielded, not publicly readable)
```

## Encryption Design

### Encryption scheme

The SDK uses **XChaCha20-Poly1305** as its single symmetric AEAD encryption scheme:

| Scheme                 | Nonce | Tag  | Birthday bound   | Notes                                                  |
| ---------------------- | ----- | ---- | ---------------- | ------------------------------------------------------ |
| **XChaCha20-Poly1305** | 24 B  | 16 B | 2⁸⁰ (negligible) | 192-bit nonce; safe for random generation indefinitely |

XChaCha20-Poly1305's 192-bit nonce pushes the birthday bound to 2⁸⁰, making random nonce collision a non-issue in practice.

### Two-layer encryption

The SDK encrypts two distinct things using the same derived key:

| Layer               | What is encrypted                            | Where it lives                       |
| ------------------- | -------------------------------------------- | ------------------------------------ |
| **Data payload**    | The user's file / content bytes              | Off-chain storage (Arweave, Mock, …) |
| **Storage pointer** | The storage network content ID (`storageId`) | On-chain (`DataRegistry` contract)   |

Encrypting the storage pointer means a blockchain observer cannot learn which decentralised-storage resource belongs to which wallet, even though the on-chain record is public.

#### Public mode (`isPublic: true`)

The SDK supports an explicit opt-in public mode:

```typescript
await sdk.upload(data, { isPublic: true });
```

In public mode **neither layer is encrypted**:

- The data payload is stored as raw bytes on the storage network — anyone with the storageId can read it.
- The storageId is written to the chain as plaintext — anyone watching the chain can see which storage resource belongs to which on-chain record.
- `connect()` / `init()` is not required; no wallet or encryption key is needed.
- The on-chain `encryptionScheme` field is set to `""` (empty string), which the SDK uses on read to skip decryption entirely.

> **Warning**: Public mode is a permanent, irreversible choice per upload. Once data is stored unencrypted on Arweave (or another permanent storage network) it cannot be made private retroactively. Only use `isPublic: true` for data you explicitly intend to be world-readable.

The default (`isPublic` omitted or `false`) always encrypts both layers. Omitting the flag is safe — accidental public uploads require an explicit opt-in.

**Key reuse across layers is safe** because XChaCha20-Poly1305 generates a fresh random nonce per encryption call. Security only requires that the same (key, nonce) pair is never reused — the key itself may be reused across independent messages with distinct nonces. The data payload and the storageId are encrypted in separate calls with independently generated nonces, so there is no cross-layer nonce collision risk.

### Key derivation

The raw seed bytes returned by the `EncryptionSeedProvider` are used to derive a Key Encryption Key (KEK) via HKDF-SHA-256. A fresh random Data Encryption Key (DEK) is generated per upload, encrypted under the KEK, and stored alongside the on-chain reference in the `keyEnvelope` field.

| Layer | Primitive    | Salt (fixed)            | Info label                             |
| ----- | ------------ | ----------------------- | -------------------------------------- |
| KEK   | HKDF-SHA-256 | `"dstorage-xchacha-v1"` | `"dstorage:xchacha20poly1305:v1"`      |
| DEK   | random       | —                       | 32 bytes from `crypto.getRandomValues` |

HKDF is appropriate here because the seed input is always high-entropy (32 bytes from scrypt, a BIP-39 derivation, or similar). The fixed info label provides domain separation between the KEK and any other keys derived from the same seed.

### Seed providers

The `@dstorage/seed-providers` package is responsible for producing the raw seed bytes that feed the key-derivation functions above.

| Provider               | Seed source                                | Cross-device portability                                     |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| `PasswordSeedProvider` | scrypt(password, caller-supplied salt)     | ✅ Same seed on any device — depends only on password + salt |
| `MnemonicSeedProvider` | BIP-39 mnemonic phrase or 64-byte hex seed | ✅ Same seed wherever the same mnemonic/hex is imported      |

#### Cross-device portability

| Scenario                                                                 | Expected outcome                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Same password + same salt on a different device (`PasswordSeedProvider`) | ✅ Same seed — scrypt output depends only on password, salt, and KDF params; no wallet required. |
| BIP-39 mnemonic imported on a different machine (`MnemonicSeedProvider`) | ✅ Same seed — the mnemonic is the only input; derivation is purely deterministic.               |
| Different password, same salt (`PasswordSeedProvider`)                   | ❌ Different seed — intentional; each password produces an independent key.                      |

---

### Wire formats

#### Off-chain data payload

The encrypted data payload is stored as a JSON object alongside the content. The `encryptionScheme` field in the on-chain `MetaTransaction` record tells the SDK which format to expect on read (see [Scheme detection](#scheme-detection-on-read)).

**XChaCha20-Poly1305** (JSON):

```json
{
  "ciphertext": "<base64 — XChaCha20 output: ciphertext || 16-byte Poly1305 tag>",
  "nonce": "<base64 — 24-byte random nonce>",
  "algorithm": "XChaCha20-Poly1305"
}
```

#### On-chain storageId encryption layout

**XChaCha20-Poly1305** (72 bytes, base64url-encoded → 96 chars):

```
[ nonce: 24 bytes | ciphertext: 32 bytes | Poly1305 tag: 16 bytes ]
```

### Scheme detection on read

The encryption scheme used for a record is stored in the `encryptionScheme` field of the on-chain `MetaTransaction`. When reading, the SDK reads this field and dispatches to the matching scheme:

| `encryptionScheme` value | Behaviour                                                                         |
| ------------------------ | --------------------------------------------------------------------------------- |
| `"xchacha20poly1305-v1"` | Unwrap DEK from `keyEnvelope`, decrypt with XChaCha20-Poly1305                    |
| `""` or absent           | No decryption — content is public (see [Public mode](#public-mode-ispublic-true)) |

The `encryptionScheme` field is stored on-chain alongside the reference. On read, the SDK checks this field and dispatches accordingly — no action required from the caller.

### Tamper detection

**Authenticated Encryption with Associated Data (AEAD)**. The Poly1305 tag (XChaCha) covers the ciphertext. Any bit-flip in the on-chain encrypted pointer causes decryption to throw before the SDK ever attempts to fetch from storage.

### Storage ID format

All storage IDs are 43-character base64url strings — 32 random bytes encoded without padding. This matches the Arweave transaction ID format and guarantees a fixed-width 32-byte plaintext input for the storageId encryption functions.

### Key loss and data recovery

Encryption keys are derived deterministically from the seed provider's inputs — no key material is stored by the SDK. This means:

- **The same inputs always produce the same key**: reconnecting with the same provider and credentials decrypts existing data transparently.
- **Losing your credentials means permanent data loss.** There is no key escrow, no recovery mechanism, and no way to decrypt data without the original inputs:
  - `PasswordSeedProvider` — forgetting the password or losing the salt string makes data unrecoverable.
  - `MnemonicSeedProvider` / wallet providers — losing the seed phrase or private key has the same effect. Follow standard seed-phrase backup practices.

---

## Supported Providers

### Storage

| Provider                   | Status     | Notes                                         |
| -------------------------- | ---------- | --------------------------------------------- |
| Mock (localStorage/memory) | ✅ Live    | Perfect for development & demos               |
| Arweave Local              | ✅ Live    | Local arlocal integration testing             |
| Arweave                    | ✅ Live    | Requires `arweave` package + Wander wallet |
| Autonomi                   | 🔵 Stub    | Awaiting Autonomi JS SDK stability            |

### Blockchain

| Chain        | Status  | Notes                                  |
| ------------ | ------- | -------------------------------------- |
| Mock         | ✅ Live | Simulates on-chain references locally  |
| MockMidnight | ✅ Live | Simulated Midnight-like chain behavior |
| Midnight     | ✅ Live | Connector + facade modes supported     |

---

## Known Limitations

- Browser Midnight connector flows require wallet extension availability and compatible network configuration.
- Autonomi adapter is currently a stub path.
