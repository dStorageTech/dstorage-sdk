<img src="docs/dStorage-logo-image-monochrome.png" alt="dStorage logo" width="80" />

# dStorage SDK

[![npm](https://img.shields.io/npm/v/@dstorage-tech/dstorage-sdk.svg)](https://www.npmjs.com/package/@dstorage-tech/dstorage-sdk)
[![CI](https://github.com/dStorageTech/dstorage-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/dStorageTech/dstorage-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Privacy-first data layer for dApps — client-side encryption + decentralised storage + on-chain coordination in a single SDK.

For teams building privacy-sensitive dApps (health, identity, finance, and enterprise workflows) that need strong client-side confidentiality without operating plaintext data infrastructure.

> ⚠️ **Pre-1.0, active development**: APIs may still change between minor versions. It's safe to follow the guides, but hold off on production use for now.

## Table of Contents

- [What it does](#what-it-does)
- [Quick Start](#quick-start)
- [Managing References](#managing-references)
- [Browser Usage](#browser-usage)
- [Midnight ZK Artifacts](#midnight-zk-artifacts)
- [Payments](#payments)
- [Error Handling](#error-handling)
- [Architecture](#architecture)
- [Encryption Design](#encryption-design)
- [Supported Providers](#supported-providers)
- [Known Limitations](#known-limitations)
- [Demo Apps](#demo-apps)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## What it does

Instead of dApps collecting and storing user data on centralised servers, dStorage shifts data ownership to the user:

- **Encrypts** data client-side using keys derived from a pluggable encryption adapter (password, wallet signature, mnemonic, or custom)
- **Pays** storage and chain networks using adapter-defined tokens (MOCK, AR, DUST)
- **Stores** encrypted blobs on decentralised storage (Mock, Arweave Local, Arweave, ...)
- **Writes** cryptographic references on-chain (Mock, Midnight)
- **Decrypts** locally on the user side — dApp operators and backend servers never see raw user data

Privacy becomes an **architectural guarantee**, not a compliance promise.

Most applications store user data on servers they control. That means users have to trust that the service provider won't read, sell, or lose their data — and history shows that trust is often misplaced. dStorage takes a different approach: data is encrypted on the user's device before it ever leaves, stored on a decentralised network where no single party has control, and a tamper-proof on-chain record ties the data back to its owner. The service provider never sees the plaintext. Neither does anyone else.

The way it works is straightforward. When a user uploads something, the SDK encrypts it locally using a key derived from an encryption adapter — a key that only they can regenerate. The encrypted blob goes to a storage network (Arweave, Arweave Local, or a mock for development). A lightweight reference — just a storage ID — is then written to a blockchain, giving the owner a verifiable receipt. To retrieve the data, the process runs in reverse: look up the reference on-chain, fetch the blob/s, decrypt them locally. At no point does any server hold an unencrypted copy.

For developers, the SDK is designed to get out of the way. You configure it once with the storage and chain backends that fit your stack, call `init()`, and use `store` and `retrieveByRefId`. You can start entirely with in-memory mocks (no network, no tokens, no wallet extension), and swap in network-backed adapters when you are ready.

---

## Quick Start

Requires Node.js 22+.

```sh
npm install @dstorage-tech/dstorage-sdk
```

```typescript
import {
  DStorage,
  MockStorageAdapter,
  MockChainAdapter,
  PasswordEncryptionAdapter,
} from "@dstorage-tech/dstorage-sdk";

// 1. Configure the SDK with your chosen adapters and encryption adapter(s)
const sdk = new DStorage({
  storageAdapters: [new MockStorageAdapter()], // swap for ArweaveStorageAdapter, ArweaveLocalStorageAdapter, etc.
  chainAdapters: [new MockChainAdapter()], // swap for MidnightChainAdapter; omit for storage-only mode
  encryptionAdapters: [
    new PasswordEncryptionAdapter({
      password: "correct-horse-battery-staple",
      salt: "myapp:v1:alice@example.com", // app + user identifier — store this alongside your data
    }),
    // Multiple adapters are supported — any one of them can independently decrypt.
    // e.g. add a MnemonicEncryptionAdapter({ mnemonic: "..." }) as a backup key.
  ],
});

// 2. Init — derives the encryption key and prepares the chain contract
await sdk.init();

// 3. Encrypt, store, and write an on-chain reference in one call
const { chainRefId, storageId } = await sdk.store(
  new TextEncoder().encode("Hello dStorage!"),
);

// 4. Retrieve and decrypt by on-chain reference ID
// (`chainRefId` is always set when `chainAdapters` is configured)
const { bytes } = await sdk.retrieveByRefId(chainRefId!);
console.log(new TextDecoder().decode(bytes)); // "Hello dStorage!"

// 5. Or retrieve directly by storage ID
const { bytes: direct } = await sdk.retrieveByStorageId(storageId);
console.log(new TextDecoder().decode(direct)); // "Hello dStorage!"
```

`store()` also accepts an options object as the second argument:

```typescript
const { chainRefId } = await sdk.store(bytes, {
  metadata: { filename: "report.pdf", version: "2" },
  onProgress: ({ phase, chunksUploaded, totalChunks }) => {
    console.log(`${phase}: ${chunksUploaded}/${totalChunks} chunks`);
  },
  // isPublic: true,  // opt-in: stores and references unencrypted (irreversible — see below)
});
```

### Multiple storage and chain adapters (fallback)

`storageAdapters` and `chainAdapters` are both **arrays in priority order**. With a single entry (the common case) the SDK behaves exactly like a single adapter. With more than one, every read and write tries each adapter in order and falls back to the next on failure, succeeding as soon as one works:

```typescript
const sdk = new DStorage({
  // Fall back to a second gateway if the primary one is unreachable
  storageAdapters: [primaryArweaveAdapter, mirrorArweaveAdapter],
  chainAdapters: [midnightAdapter],
  encryptionAdapters: [passwordAdapter],
});
```

- `storageAdapters` is required and must contain at least one adapter.
- `chainAdapters` is optional. Omitting it (or passing `[]`) puts the SDK in **storage-only mode**: content is encrypted and stored, but no on-chain reference is written.
- `listReferences()` is the exception to "first success wins": it aggregates references from **every** configured chain adapter. Single-reference operations (`update()`, `removeReference()`, `rotateKeys()`, `retryUpdate()`) target whichever chain adapter holds that reference.
- Chunked uploads are retried as a whole against the next storage adapter, never chunk by chunk. `StoreProgress.attemptIndex` tells you which candidate is being tried.

### Arweave Local (development)

[arlocal](https://github.com/textury/arlocal) is a local Arweave node for development and testing. `ArweaveLocalStorageAdapter` targets it by default (`localhost:1984`).

**Path A — auto-generated test wallet** (recommended for local dev and tests):

```typescript
import { ArweaveLocalStorageAdapter } from "@dstorage-tech/dstorage-sdk";

// Spins up a funded wallet against the running arlocal instance
const { adapter: storageAdapter } =
  await ArweaveLocalStorageAdapter.createWithTestWallet({
    fundAr: 10, // AR tokens to mint (default: 10)
  });
```

**Path B — existing wallet key file** (e.g. a pre-funded JWK on disk):

```typescript
import fs from "node:fs";
import { ArweaveLocalStorageAdapter } from "@dstorage-tech/dstorage-sdk";

const walletKey = JSON.parse(fs.readFileSync("arweave-wallet.json", "utf8"));
const storageAdapter = new ArweaveLocalStorageAdapter({ walletKey });
```

**Path C — custom gateway host and port** (e.g. arlocal running on a different machine or port):

```typescript
import { ArweaveLocalStorageAdapter } from "@dstorage-tech/dstorage-sdk";

const storageAdapter = new ArweaveLocalStorageAdapter({
  gateway: { host: "192.168.1.42", port: 4000, protocol: "http" },
});
```

---

## Managing References

Beyond `store()` and `retrieveByRefId()`/`retrieveByStorageId()`, the SDK exposes lifecycle operations for references you've already written on-chain. All of these require at least one chain adapter (`chainAdapters`) — they throw if the SDK is configured in storage-only mode.

### Listing references

```typescript
// All references the chain adapter can enumerate (requires listReferences() support —
// e.g. MockChainAdapter, MidnightChainAdapter)
const refs = await sdk.listReferences();

// Or a targeted lookup by refId — skips the full on-chain scan
const refs = await sdk.listReferences({ refIds: [chainRefId] });

for (const ref of refs) {
  if (ref.decryptionError) {
    // Not owned by any of your configured encryption adapters — someone else's
    // reference, or the key has since been rotated away from you.
    continue;
  }
  console.log(ref.refId, ref.storageId, ref.metadata);
}
```

Each `DataReferenceSummary` carries `decryptionError` when none of your configured encryption adapters can unwrap its key envelope — absence of that field means you can decrypt (and therefore manage) the reference. The targeted `refIds` form doesn't populate `ownerCommitment` (left as `""`) since it reads each reference directly rather than via the chain adapter's full listing.

### Updating content in place

```typescript
const { chainRefId, storageId } = await sdk.update(existingRefId, newBytes, {
  metadata: { version: "3" },
});
```

`update()` re-derives the `ownerSecret` from the existing reference to prove ownership, encrypts the new content under a fresh DEK, and replaces the reference's on-chain fields — `refId` stays the same. **The old content is not deleted or overwritten in storage**; if you retained the previous `storageId`, it remains independently decryptable. Only the chain reference now points at the new version.

> **Warning**: `update()` always encrypts, even if the original reference (or the `options` you pass) used `isPublic: true` — the `isPublic` field on `StoreOptions` is silently ignored by `update()`. There is currently no way to update a reference back into public mode; if you need that, `removeReference()` the old one and `store()` a new public upload.

Requires a chain adapter whose `ChainAdapter` implementation supports `updateReference()` — not all adapters do (throws if unsupported).

### Removing a reference

```typescript
await sdk.removeReference(chainRefId);
```

Deletes the on-chain reference only — the underlying content in storage is untouched (decentralised storage networks like Arweave are generally append-only/permanent, so there is nothing for the SDK to delete there). Ownership is enforced by the chain (via a ZK proof over the witness-derived `ownerSecret`) — only whoever can re-derive that secret from one of their configured encryption adapters can successfully remove a reference.

### Rotating encryption keys

```typescript
// e.g. changing a password: configure both the new and the still-valid old
// adapter, then rotate — the old wrapper is dropped from the envelope.
const sdk = new DStorage({
  storageAdapters: [storageAdapter],
  chainAdapters: [chainAdapter],
  encryptionAdapters: [
    new PasswordEncryptionAdapter({ password: newPassword, salt }),
    new MnemonicEncryptionAdapter({ mnemonic: backupPhrase }), // proves ownership
  ],
});
await sdk.init();
await sdk.rotateKeys(chainRefId);
// From this point, the old password's wrapper is gone — only the adapters
// configured on this SDK instance (new password + mnemonic) can decrypt.
```

`rotateKeys()` re-wraps the existing DEK under exactly the encryption adapters currently configured on the SDK instance — content in storage is never touched or re-uploaded, only the on-chain `keyEnvelope` changes. Any single adapter that matches a wrapper already in the reference's envelope is sufficient to authorise the rotation (it proves ownership by unwrapping the existing DEK). Use it to change a password, swap in a new device's keypair, or drop an adapter you no longer want to be able to decrypt this reference — whatever `encryptionAdapters` the SDK is configured with at call time becomes the new, complete set.

---

## Browser Usage

The same `npm install @dstorage-tech/dstorage-sdk` import works in the browser — no
separate package, no subpath required:

```typescript
import { DStorage, ArweaveStorageAdapter } from "@dstorage-tech/dstorage-sdk";
```

Bundlers configured for a browser target (Vite, webpack 5+, Rollup, esbuild) resolve the
plain import to a pre-built, browser-safe bundle automatically via the `"browser"`
condition in `package.json`'s `exports` map. It is not minified — minification strips
the `/* @vite-ignore */` comments that tell a bundler to skip static analysis of
Node-only code paths (e.g. `MidnightChainAdapter`'s facade/provider mode, which
dynamically imports `fs` and LevelDB). Those Node-only paths are present in the bundle
but statically unreachable in connector mode. For tooling that doesn't resolve
conditional exports, or for explicit clarity, the same bundle is also available at the
`/browser` subpath:

```typescript
import {
  DStorage,
  ArweaveStorageAdapter,
} from "@dstorage-tech/dstorage-sdk/browser";
```

### What is and is not included

| Adapter                                       | Browser bundle | Reason for exclusion                                                                              |
| --------------------------------------------- | :------------: | ------------------------------------------------------------------------------------------------- |
| `MockStorageAdapter`                          |       ✅       |                                                                                                   |
| `ArweaveStorageAdapter`                       |       ✅       |                                                                                                   |
| `ArweaveBundlerStorageAdapter`                |       ✅       |                                                                                                   |
| `ArweaveLocalStorageAdapter`                  |       ✅       | Requires arlocal running at a browser-reachable URL — see note below                              |
| `MockPaymentAdapter`                          |       ✅       |                                                                                                   |
| `ArweavePaymentAdapter`                       |       ✅       |                                                                                                   |
| `ManagedPaymentAdapter`                       |       ✅       |                                                                                                   |
| `MockChainAdapter`                            |       ✅       |                                                                                                   |
| `MidnightSimulatorChainAdapter`               |       ✅       |                                                                                                   |
| `HttpGatewayChainAdapter`                     |       ✅       |                                                                                                   |
| `MidnightChainAdapter` (connector mode)       |       ✅       | Requires Lace wallet extension; endpoints come from the wallet unless configured — see note below |
| `MidnightChainAdapter` (provider/facade mode) |       ❌       | Requires LevelDB (private state) and filesystem (ZK artifacts) — Node.js only                     |

**`ArweaveLocalStorageAdapter` in browsers**: arlocal sets `Access-Control-Allow-Origin: *` by default, so no extra CORS configuration is required. Start arlocal as usual (`docker run -p 1984:1984 textury/arlocal` or `npx arlocal`) and point the adapter at the arlocal URL:

```typescript
import {
  ArweaveLocalStorageAdapter,
  ARWEAVE_LOCAL,
} from "@dstorage-tech/dstorage-sdk/browser";

const { adapter } = await ArweaveLocalStorageAdapter.createWithTestWallet();
// or with a custom host/port:
const adapter2 = new ArweaveLocalStorageAdapter({
  gateway: { host: "mydev.local", port: 1984, protocol: "http" },
});
```

If arlocal runs on a non-localhost host, verify that your reverse proxy or network path preserves the CORS headers arlocal sets. Browsers treat `localhost` as a secure context, so HTTP connections to `localhost:1984` are not blocked even when the app is served over HTTPS.

**`MidnightChainAdapter` in browsers**: only **connector mode** (`walletMode: "connector"`) is supported in the browser bundle. It connects to the Lace wallet extension, fetches ZK artifacts over HTTP (`FetchZkConfigProvider`), and stores private state in memory.

The adapter has no built-in endpoint defaults. In connector mode the indexer endpoints come from the connected wallet's configuration, unless you set them yourself. Endpoints you set always take priority over the wallet's:

```typescript
import {
  MidnightChainAdapter,
  NETWORKS,
} from "@dstorage-tech/dstorage-sdk/browser";

const chain = new MidnightChainAdapter({
  walletMode: "connector",
  network: NETWORKS.preprod.networkId, // must match the wallet's network, or init() throws
  proofServerEndpoint: "http://127.0.0.1:6300", // required with the default prover
  // indexerEndpoint / indexerWsEndpoint: optional, override the wallet's indexer
  zkConfigBaseUrl: window.location.origin, // serve keys/ and zkir/ from public/
});
```

In connector mode, `prover` selects where ZK proofs are generated:

| `prover`                                     | Proofs generated by                                                            | `proofServerEndpoint` |
| -------------------------------------------- | ------------------------------------------------------------------------------ | --------------------- |
| `PROVER_MODE.PROOF_SERVER_URL` (default)     | the proof server at `proofServerEndpoint`                                      | required              |
| `PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER` | the proof server the wallet reports (`proverServerUri`), called by the adapter | must not be set       |
| `PROVER_MODE.WALLET_DELEGATED`               | the wallet itself, via the DApp Connector `getProvingProvider()`               | must not be set       |

```typescript
import { PROVER_MODE } from "@dstorage-tech/dstorage-sdk/browser";

const chain = new MidnightChainAdapter({
  walletMode: "connector",
  network: NETWORKS.preprod.networkId,
  prover: PROVER_MODE.WALLET_DELEGATED,
  zkConfigBaseUrl: window.location.origin, // the wallet fetches keys/ and zkir/ from here
});
```

The adapter never falls back from one prover mode to another: if the selected source is unavailable, writes fail with an error. Both wallet options hand the ZK witness inputs, including the secret that authorizes updating and removing a reference, to something the wallet controls. Use them only with a wallet extension you trust. The `allowWalletProofServer` option was removed; use `prover: PROVER_MODE.WALLET_CONFIGURED_PROOF_SERVER` instead.

In provider mode, `indexerEndpoint`, `indexerWsEndpoint` and `proofServerEndpoint` are required. `NETWORKS` only lists the known network ids (`preprod`, `preview`, `undeployed`); it contains no endpoints.

Provider/facade mode (`walletMode: "provider"`) is Node.js-only and cannot run in a browser — it requires LevelDB for persistent private state and local filesystem access for ZK artifact files.

---

## Midnight ZK Artifacts

`MidnightChainAdapter` writes on-chain references through dStorage's own `DataRegistry`
contract — the same fixed contract for every consumer, not something you compile
yourself. Its compiled ZK artifacts (prover/verifier keys and ZKIR) ship inside this
package at `dist/contracts/dataregistry/managed/{keys,zkir}`.

**Node.js (`walletMode: "provider"`)** — point `zkArtifactsPath` at the bundled copy.
Resolving it via the package's own `package.json` (rather than hardcoding a
`node_modules` path) works regardless of hoisting or package manager:

```typescript
import { createRequire } from "node:module";
import path from "node:path";

const pkgJsonPath = createRequire(import.meta.url).resolve(
  "@dstorage-tech/dstorage-sdk/package.json",
);
const zkArtifactsPath = path.join(
  path.dirname(pkgJsonPath),
  "dist/contracts/dataregistry/managed",
);

const chainAdapter = new MidnightChainAdapter({
  walletMode: "provider",
  walletProvider,
  privateStatePassword,
  zkArtifactsPath,
  // ...
});
```

**Browser (`walletMode: "connector"`)** — the browser bundle can't read from
`node_modules`, so copy the same directory into your app's own static assets as part of
your build (mirroring how any Midnight dApp serves its compiled contract artifacts —
see the [Midnight docs](https://docs.midnight.network/) for the general pattern), then
point `zkConfigBaseUrl` at wherever you serve it from:

```sh
cp -a node_modules/@dstorage-tech/dstorage-sdk/dist/contracts/dataregistry/managed/keys ./public/
cp -a node_modules/@dstorage-tech/dstorage-sdk/dist/contracts/dataregistry/managed/zkir ./public/
```

```typescript
const chainAdapter = new MidnightChainAdapter({
  walletMode: "connector",
  zkConfigBaseUrl: window.location.origin, // serves keys/ and zkir/ from public/
  // ...
});
```

---

## Payments

Every upload involves two costs — paying storage and chain operations. The SDK orchestrates this through pluggable payment adapters. Depending on adapter choice, payments can be simulated (mock/preview) or real.

### How it works

```typescript
// Estimate costs before committing
const bytes = new TextEncoder().encode("Hello dStorage!");
const estimate = await sdk.estimateCost(bytes.byteLength);
// -> { storageCost: { amount, token }, chainCost: { amount, token }, fileSizeBytes }

// Encrypt, upload, and pay storage + chain costs in one call
const result = await sdk.store(bytes, {
  onProgress: (progress) => {
    console.log(progress.phase); // 'encrypting' | 'uploading' | 'stored' | 'finalizing'
  },
});

console.log(result.costEstimate.storageCost); // Amount + token paid for storage
console.log(result.costEstimate.chainCost); // Amount + token paid for the chain tx
console.log(result.chainRefId); // On-chain reference ID
```

### Supported tokens

| Token  | Network  | Used for                                                             |
| ------ | -------- | -------------------------------------------------------------------- |
| `AR`   | Arweave  | Storage payment — `ArweavePaymentAdapter` or `ManagedPaymentAdapter` |
| `DUST` | Midnight | Chain fees — handled internally by the Midnight wallet               |
| `MOCK` | Mock     | Development & testing (simulated)                                    |

Tokens are selected automatically based on your chosen adapters.

---

## Error Handling

Every error thrown by the SDK is a `DStorageError` — a subclass of `Error` that always carries a numeric `.code`. Use the `isDStorageError` type guard to distinguish SDK errors from unexpected runtime failures:

```typescript
import { isDStorageError } from "@dstorage-tech/dstorage-sdk";

try {
  await sdk.store(bytes);
} catch (err) {
  if (isDStorageError(err)) {
    console.error(`SDK error (code ${err.code}): ${err.message}`);
  } else {
    throw err; // should not happen — all SDK errors are DStorageError
  }
}
```

Error codes are namespaced by package:

| Range       | Package                |
| ----------- | ---------------------- |
| 10000–10999 | `@dstorage/core`       |
| 11000–11999 | `@dstorage/chain`      |
| 12000–12999 | `@dstorage/crypto`     |
| 13000–13999 | `@dstorage/encryption` |
| 14000–14999 | `@dstorage/payment`    |
| 15000–15999 | `@dstorage/storage`    |

Code `10999` (`UNKNOWN_ERROR`) is a catch-all — it means an error escaped without an explicit code. If you see it, it is a bug worth reporting.

### Handling partial failures

`store()` uploads content first, then writes the on-chain reference. If the chain write fails after a successful storage upload, `store()` throws a `StorePartialError` — a `DStorageError` subclass with a `recovery` payload. Use it with `registerReference()` to retry only the chain write without re-uploading:

```typescript
import { isStorePartialError } from "@dstorage-tech/dstorage-sdk";

try {
  await sdk.store(bytes);
} catch (err) {
  if (isStorePartialError(err)) {
    const { storageId, storageProvider, keyEnvelope } = err.recovery;
    const { chainRefId } = await sdk.registerReference({
      storageId,
      storageProvider,
      keyEnvelope,
    });
  }
}
```

For resilience against crashes before the chain write, persist the recovery payload from the `"stored"` progress phase:

```typescript
await sdk.store(bytes, {
  onProgress(p) {
    if (p.phase === "stored" && p.recovery) {
      localStorage.setItem("pending-store", JSON.stringify(p.recovery));
    }
  },
});
localStorage.removeItem("pending-store"); // clear on success
```

`keyEnvelope` is the DEK already wrapped under your KEK — safe to persist. The raw DEK is never exposed.

`StorePartialError`'s message also appends the underlying chain-write failure (e.g. a payment adapter's HTTP error), and sets it as the standard `.cause` — so `err.message` and `err.cause` both carry the real reason the write failed, not just the generic "on-chain reference write failed" text.

### Handling partial update failures

`update()` follows the identical pattern: content is stored first, then the on-chain reference is rewritten. If the chain write fails after the new content is already stored, `update()` throws the same `StorePartialError`. Recover with `retryUpdate()` instead of `registerReference()` — it targets the existing `refId` rather than creating a new reference:

```typescript
import { isStorePartialError } from "@dstorage-tech/dstorage-sdk";

try {
  await sdk.update(existingRefId, newBytes);
} catch (err) {
  if (isStorePartialError(err)) {
    const { chainRefId } = await sdk.retryUpdate(existingRefId, err.recovery);
  }
}
```

As with `store()`, persist `err.recovery` (or the `recovery` payload from the `"stored"` `onProgress` phase) if you need resilience against a crash between the storage upload and the chain write.

---

## Architecture

```
@dstorage-tech/dstorage-sdk     ← Developer-facing API (npm install @dstorage-tech/dstorage-sdk)
    ├── @dstorage/crypto        ← XChaCha20-Poly1305 encryption, key derivation
    ├── @dstorage/encryption    ← Encryption adapters: PasswordEncryptionAdapter | MnemonicEncryptionAdapter | KeypairEncryptionAdapter | WebAuthnPrfEncryptionAdapter
    ├── @dstorage/storage       ← Storage adapters: Mock | Arweave | ArweaveBundler | Arweave Local
    ├── @dstorage/payment       ← Payment adapters: Mock | Arweave | Managed
    └── @dstorage/chain         ← Chain adapters:   Mock | MidnightSimulator | Midnight
```

All 5 workspace packages are bundled inline into `packages/core`'s output — every
adapter above is resolvable from a single `npm install @dstorage-tech/dstorage-sdk`,
not just the Mock ones. (`arweave`, `@midnight-ntwrk/*`, `@dha-team/arbundles`, etc. are
real dependencies of the published package — see [Browser Usage](#browser-usage).)

### Data Flow

```
User input
    │
    ▼
[encrypt]      ← key derived from encryption adapter (password, wallet, mnemonic…)
    │              (key never leaves the device)
    ▼
[pay storage]  → adapter-defined token (commonly AR / MOCK)
    │
    ▼
[store]        → Encrypted blob → Arweave / Arweave Local / Mock
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

### Large-file chunking

Files larger than **10 MB** are automatically split into independently encrypted 10 MB chunks. Each chunk is uploaded as a separate storage transaction; a small manifest file ties them together and its `storageId` is the single pointer written on-chain. The split/reassembly is entirely transparent to the caller — `store()`, `retrieveByRefId()`, and `retrieveByStorageId()` behave identically regardless of file size.

---

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
await sdk.store(data, { isPublic: true });
```

In public mode **neither layer is encrypted**:

- The data payload is stored as raw bytes on the storage network — anyone with the storageId can read it.
- The storageId is written to the chain as plaintext — anyone watching the chain can see which storage resource belongs to which on-chain record.
- `init()` is still required, same as private uploads.
- When chain adapters are configured, at least one encryption adapter is still required even in public mode — it's used to derive the owner secret needed to later update or remove the reference, not to encrypt the payload. Configuring no encryption adapters at all only works in storage-only mode (no `chainAdapters`).
- The on-chain `encryptionScheme` field is set to `""` (empty string), which the SDK uses on read to skip decryption entirely.

> **Warning**: Public mode is a permanent, irreversible choice per upload. Once data is stored unencrypted on Arweave (or another permanent storage network) it cannot be made private retroactively. Only use `isPublic: true` for data you explicitly intend to be world-readable.

The default (`isPublic` omitted or `false`) always encrypts both layers.

**Key reuse across layers is safe** because XChaCha20-Poly1305 generates a fresh random nonce per encryption call. The data payload and the storageId are encrypted in separate calls with independently generated nonces, so there is no cross-layer nonce collision risk.

### Key derivation

The raw seed bytes returned by the `EncryptionAdapter` are used to derive a Key Encryption Key (KEK) via HKDF-SHA-256. A fresh random Data Encryption Key (DEK) is generated per upload, encrypted under the KEK, and stored alongside the on-chain reference in the `keyEnvelope` field.

| Layer | Primitive    | Salt (fixed)            | Info label                             |
| ----- | ------------ | ----------------------- | -------------------------------------- |
| KEK   | HKDF-SHA-256 | `"dstorage-xchacha-v1"` | `"dstorage:xchacha20poly1305:v1"`      |
| DEK   | random       | —                       | 32 bytes from `crypto.getRandomValues` |

### Encryption adapters

The `@dstorage/encryption` package is responsible for producing the raw seed bytes that feed the key-derivation functions above.

| Adapter                        | Seed source                                                                                                        | Post-quantum safety                                                                                                                                                                                                                      | Cross-device portability                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PasswordEncryptionAdapter`    | scrypt(password, caller-supplied salt)                                                                             | ⚠️ 128-bit PQ at the data layer (NIST minimum). Key encapsulation safety depends on password entropy — use `generateHighEntropyPassword()` for a machine-generated 256-bit password (128-bit PQ, NIST category 1).                       | ✅ Same seed on any device — depends only on password + salt                                                                                                     |
| `MnemonicEncryptionAdapter`    | BIP-39 mnemonic phrase (**24 words required**) or 64-byte hex seed                                                 | ✅ 128-bit PQ — unconditional (CSPRNG-generated 256-bit entropy; Grover's halves to 128-bit). Fewer than 24 words is rejected at construction.                                                                                           | ✅ Same seed wherever the same mnemonic/hex is imported                                                                                                          |
| `KeypairEncryptionAdapter`     | ML-KEM public/secret key pair (NIST FIPS 203 — post-quantum)                                                       | ✅ 192-bit PQ via ML-KEM768 for a randomly generated keypair (`generateKeypair()`). A keypair **derived** from a password/mnemonic (`fromPassword()` / `fromMnemonic()`) is capped at ~128-bit by the derivation input's Grover ceiling. | ⚠️ Requires the Secret Key for decryption — not re-derivable unless created via `fromPassword()` / `fromMnemonic()`                                              |
| `WebAuthnPrfEncryptionAdapter` | WebAuthn PRF extension output (passkey — platform authenticator or CTAP2 `hmac-secret` security key, e.g. YubiKey) | ✅ 128-bit PQ — unconditional (authenticator-generated 256-bit PRF output, not human-chosen; Grover's halves it to 128-bit).                                                                                                             | ⚠️ Requires the same physical passkey — portable across devices only if the passkey syncs (e.g. platform passkey sync) or the same hardware key is carried along |

#### Cross-device portability

| Scenario                                                                                       | Expected outcome                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Same password + same salt on a different device (`PasswordEncryptionAdapter`)                  | ✅ Same seed — scrypt output depends only on password, salt, and KDF params; no wallet required.                                               |
| BIP-39 mnemonic imported on a different machine (`MnemonicEncryptionAdapter`)                  | ✅ Same seed — the mnemonic is the only input; derivation is purely deterministic.                                                             |
| Different password, same salt (`PasswordEncryptionAdapter`)                                    | ❌ Different seed — intentional; each password produces an independent key.                                                                    |
| ML-KEM keypair from `generateKeypair()` re-imported (`KeypairEncryptionAdapter`)               | ✅ Same keypair wherever the SK bytes are imported — but the SK must be stored; it cannot be re-derived.                                       |
| ML-KEM keypair from `fromPassword()` or `fromMnemonic()` (`KeypairEncryptionAdapter`)          | ✅ Same keypair — deterministic; no key storage needed, re-derive from password+salt or mnemonic at any time.                                  |
| `KeypairEncryptionAdapter.fromPublicKey(pk)` (upload-only)                                     | 🔒 PK-only — can wrap DEK for upload; unwrapping requires the matching SK.                                                                     |
| Same synced platform passkey used on a different device (`WebAuthnPrfEncryptionAdapter`)       | ✅ Same seed — the underlying credential secret is identical across the user's synced devices (e.g. iCloud Keychain, Google Password Manager). |
| Same roaming hardware security key used on a different device (`WebAuthnPrfEncryptionAdapter`) | ✅ Same seed — the credential secret lives on the physical key, not the device; carry the key with you.                                        |
| A new, unsynced passkey registered on a different device (`WebAuthnPrfEncryptionAdapter`)      | ❌ Different seed — a different WebAuthn credential has an independent, unrelated secret.                                                      |
| `WebAuthnPrfEncryptionAdapter.fromPublicKey(pk)` (upload-only)                                 | 🔒 PK-only — can wrap DEK for upload; unwrapping still requires re-authenticating with the owner's original passkey.                           |

#### Multi-key encryption

`encryptionAdapters` accepts an **array** of adapters. When more than one is supplied, the SDK wraps the same per-upload DEK under every KEK independently. Any single adapter can decrypt any upload made while it was in the list:

```typescript
encryptionAdapters: [
  new PasswordEncryptionAdapter({ password, salt }), // primary key
  new MnemonicEncryptionAdapter({ mnemonic: backupPhrase }), // recovery key
];
```

Both adapters can decrypt; neither knows anything about the other's credentials.

You can also mix in a post-quantum adapter — the uploader needs only the Public Key:

```typescript
const { adapter: mlkemAdapter, secretKey } =
  KeypairEncryptionAdapter.generateKeypair("myapp:v1");
// Store `secretKey` bytes safely — needed to decrypt later.
encryptionAdapters: [
  new PasswordEncryptionAdapter({ password, salt }), // symmetric fallback
  mlkemAdapter, // post-quantum DEK wrap
];
```

#### Post-quantum (ML-KEM)

`KeypairEncryptionAdapter` uses ML-KEM (CRYSTALS-Kyber, NIST FIPS 203) — a post-quantum Key Encapsulation Mechanism — to wrap the per-upload DEK. Unlike the symmetric adapters it uses an asymmetric public/secret keypair:

- **`wrapDek()`** requires only the **Public Key** — safe to hand to upload-only parties.
- **`unwrapDek()`** requires the **Secret Key** — held only by the authorised reader.

| Variant     | Post-quantum security | PK size | SK size | KEM ciphertext |
| ----------- | --------------------- | ------- | ------- | -------------- |
| `mlkem512`  | 128-bit               | 800 B   | 1632 B  | 768 B          |
| `mlkem768`  | 192-bit (default)     | 1184 B  | 2400 B  | 1088 B         |
| `mlkem1024` | 256-bit               | 1568 B  | 3168 B  | 1568 B         |

**Usage patterns:**

```typescript
// `context` is a domain-separation string binding the KEK derivation to your
// application (and, for the deterministic factories, to this specific use — pick
// a stable value and keep it consistent for any given adapter's data).

// 1 — Fresh random keypair (store the SK):
const { adapter, publicKey, secretKey } =
  KeypairEncryptionAdapter.generateKeypair("myapp:v1");

// 2 — PK-only uploader (no SK needed at upload time):
const uploader = KeypairEncryptionAdapter.fromPublicKey(publicKey, "myapp:v1");

// 3 — Full keypair reader:
const reader = KeypairEncryptionAdapter.fromKeypair(
  publicKey,
  secretKey,
  "myapp:v1",
);

// 4 — Deterministic keypair from password (same inputs → same keypair, always):
const adapter = await KeypairEncryptionAdapter.fromPassword(
  password,
  salt,
  "myapp:v1",
);

// 5 — Deterministic keypair from BIP-39 mnemonic:
const adapter = await KeypairEncryptionAdapter.fromMnemonic(
  { mnemonic },
  "myapp:v1",
);
```

#### Passkeys (WebAuthn PRF)

`WebAuthnPrfEncryptionAdapter` derives the encryption seed from a passkey via the WebAuthn PRF extension — supported by platform authenticators (Touch ID, Windows Hello, Face ID) and hardware security keys implementing the CTAP2 `hmac-secret` extension (e.g. YubiKey 5 series). No password or mnemonic to remember; the authenticator itself holds the secret.

```typescript
// 1 — Register a new passkey (prompts the authenticator) and persist the
// credential ID yourself (localStorage, a database, ...) — the adapter
// never stores it:
const adapter = await WebAuthnPrfEncryptionAdapter.register();
saveCredentialId(adapter.credentialId);

// 2 — On a later visit, re-authenticate with the same passkey:
const adapter =
  await WebAuthnPrfEncryptionAdapter.authenticate(loadCredentialIds());

// 3 — Or let the browser show its native picker across any resident passkey
// for this origin, with no credential ID persisted at all:
const adapter = await WebAuthnPrfEncryptionAdapter.authenticate([], {
  discoverable: true,
});
```

**Public-key sharing.** Every `WebAuthnPrfEncryptionAdapter` also exposes an internally-derived ML-KEM public key (`.publicKey`) — share it with a 3rd party so they can encrypt data _for_ the owner without ever touching WebAuthn themselves:

```typescript
// 3rd party — only needs the raw public key bytes, no passkey of their own:
const uploader = WebAuthnPrfEncryptionAdapter.fromPublicKey(owner.publicKey);

// Owner — a single authenticate()d adapter decrypts both their own direct
// uploads and anything wrapped for them via fromPublicKey():
const reader = await WebAuthnPrfEncryptionAdapter.authenticate(credentialIds);
```

For a custom ML-KEM context/variant beyond the default sharing keypair, or to derive a standalone `KeypairEncryptionAdapter` under your own domain-separation string, use the `intoKeypairEncryptionAdapter(context, variant?)` escape hatch — same pattern as `MnemonicEncryptionAdapter`/`PasswordEncryptionAdapter` above. `register()`/`authenticate()` also accept advanced options (`seedDerivation`, `seedExpandInfo`, `shareContext`, `shareVariant`) for interoperating with a pre-existing, non-SDK passkey derivation scheme — see the adapter's own doc comments for details.

#### Post-quantum safety across all adapters

Every private upload has two independently protected layers:

| Layer                 | Primitive                       | PQ security (all adapters)                                                                                         |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Data payload**      | XChaCha20-Poly1305, 256-bit key | ✅ 128-bit PQ — Grover's algorithm halves effective key length; NIST SP 800-131A approves 128-bit PQ as sufficient |
| **Key encapsulation** | Adapter-dependent               | Varies — see table below                                                                                           |

The **key encapsulation layer** is where adapters differ:

| Adapter                        | Key encapsulation mechanism                 | PQ safety                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PasswordEncryptionAdapter`    | scrypt(password) → HKDF-SHA-256 → KEK       | ⚠️ Conditional on password entropy. A quantum attacker can brute-force the password; human-chosen passwords cannot reach the 256-bit entropy required for PQ-safe key encapsulation. Use `generateHighEntropyPassword()` for machine-generated input.                                |
| `MnemonicEncryptionAdapter`    | BIP-39(mnemonic) → HKDF-SHA-256 → KEK       | ✅ 128-bit PQ — a 24-word BIP-39 mnemonic is CSPRNG-generated (256 bits of entropy); Grover's halves this to 128-bit. Unconditional and enforced: the adapter rejects mnemonics shorter than 24 words at construction time.                                                          |
| `KeypairEncryptionAdapter`     | ML-KEM encapsulate(PK) → HKDF-SHA-256 → KEK | ✅ 192-bit PQ for a randomly generated keypair (`generateKeypair()`) — rests on the module-LWE problem; no known quantum speedup. A keypair **derived** from a password/mnemonic (`fromPassword()` / `fromMnemonic()`) is capped at ~128-bit by the derivation input's Grover bound. |
| `WebAuthnPrfEncryptionAdapter` | WebAuthn PRF output → HKDF-SHA-256 → KEK    | ✅ 128-bit PQ — unconditional, like `MnemonicEncryptionAdapter`. The PRF output is generated by the authenticator's own hardware-backed secret, not human-chosen; Grover's halves the 256-bit output to 128-bit.                                                                     |

For **"harvest now, decrypt later"** threat models, both `MnemonicEncryptionAdapter` (128-bit PQ, unconditional) and a randomly generated `KeypairEncryptionAdapter` (`generateKeypair()`, 192-bit PQ) provide solid post-quantum guarantees at the key encapsulation level. `PasswordEncryptionAdapter` with a human-chosen password does not — use `generateHighEntropyPassword()` to raise it to the 128-bit NIST-minimum PQ level.

#### Machine-generated PQ-safe passwords

If you want cross-device password recoverability at the 128-bit (NIST-minimum) post-quantum level, use `generateHighEntropyPassword()`:

```typescript
import {
  generateHighEntropyPassword,
  KeypairEncryptionAdapter,
} from "@dstorage-tech/dstorage-sdk";

// 32 random bytes → 43-char base64url string (256 bits of real entropy).
// Store this string — it is the only secret needed to re-derive the keypair on any device.
const password = generateHighEntropyPassword();

// Derives an ML-KEM keypair via scrypt → 64-byte seed → ML-KEM keygen.
// Same password + salt + context → same keypair, always, on any device.
const adapter = await KeypairEncryptionAdapter.fromPassword(
  password,
  "myapp:v1:alice@example.com", // salt — domain separator
  "myapp:v1", // context — binds the KEK derivation to this application
);
```

A password-derived keypair is bounded at ~128-bit PQ (the password's Grover ceiling), **not** ML-KEM-768's ~192-bit — deriving ML-KEM from a password gives recoverability (no secret key to store), not a higher bit level than using the same password symmetrically. For the full ~192-bit PQ, use a randomly generated `KeypairEncryptionAdapter.generateKeypair()` and back up its secret key separately.

> **Warning — human-chosen passwords are not PQ-safe at the key encapsulation layer.**
> No human-memorable password or passphrase can reach the 256-bit entropy required to
> resist a Grover's-algorithm brute-force. Human passwords still provide 128-bit PQ
> security at the _data_ layer (NIST minimum, sufficient for most applications) but a
> quantum attacker could recover the password and rederive the KEK. For
> key-encapsulation-level PQ safety, use `generateHighEntropyPassword()` with
> `KeypairEncryptionAdapter.fromPassword()` (128-bit PQ — the derived keypair is bounded
> by the password's Grover ceiling, not ML-KEM's 192-bit), or `MnemonicEncryptionAdapter`
> with a 24-word BIP-39 mnemonic (12-word mnemonics are rejected — they give only 64-bit
> PQ security). For the full ~192-bit, use a randomly generated `generateKeypair()` with
> a separately backed-up secret key.

---

### Wire formats

#### Off-chain data payload

**XChaCha20-Poly1305** (JSON):

```json
{
  "ciphertext": "<base64 — XChaCha20 output: ciphertext || 16-byte Poly1305 tag>",
  "nonce": "<base64 — 24-byte random nonce>",
  "algorithm": "XChaCha20-Poly1305"
}
```

#### On-chain storageId encryption layout

**XChaCha20-Poly1305** (JSON) — same wire format as the off-chain payload above, with a distinct associated data (AAD) label for domain separation. The plaintext is the storageId string's UTF-8 bytes (43 bytes for the standard base64url storage ID format), not raw decoded bytes:

```json
{
  "ciphertext": "<base64 — XChaCha20 output: ciphertext || 16-byte Poly1305 tag>",
  "nonce": "<base64 — 24-byte random nonce>",
  "algorithm": "XChaCha20-Poly1305"
}
```

### Scheme detection on read

| `encryptionScheme` value | Behaviour                                                                         |
| ------------------------ | --------------------------------------------------------------------------------- |
| `"xchacha20poly1305-v1"` | Unwrap DEK from `keyEnvelope`, decrypt with XChaCha20-Poly1305                    |
| `""` or absent           | No decryption — content is public (see [Public mode](#public-mode-ispublic-true)) |

### Tamper detection

**Authenticated Encryption with Associated Data (AEAD)**. The Poly1305 tag covers the ciphertext. Any bit-flip in the on-chain encrypted pointer causes decryption to throw before the SDK ever attempts to fetch from storage.

**AAD context binding**. Beyond integrity, each ciphertext is bound to its _role and position_ via Additional Authenticated Data (AAD). The AAD is not encrypted — it is a plain label passed alongside the ciphertext — but the Poly1305 MAC covers it, so any mismatch causes decryption to fail. The SDK uses four distinct labels:

| Label      | Value                         | Purpose                                                      |
| ---------- | ----------------------------- | ------------------------------------------------------------ |
| Payload    | `"dstorage:payload:v1"`       | Single-shot file uploads (non-chunked user content)          |
| Manifest   | `"dstorage:manifest:v1"`      | The chunked upload manifest (distinct from user content)     |
| Chunk      | `"dstorage:chunk:v1:<i>/<n>"` | Each chunk in a chunked upload, bound to its index and total |
| Storage ID | `"dstorage:storageId:v1"`     | The storage pointer encrypted on-chain                       |

This means a ciphertext produced for one role cannot be silently substituted into another. In particular:

- A storage gateway that reorders or swaps chunk blobs causes decryption to throw — the MAC was computed with a different index label.
- A user file whose plaintext happens to look like a manifest JSON cannot be misinterpreted as one — a payload ciphertext (encrypted with `"dstorage:payload:v1"`) will fail MAC verification when the SDK attempts to decrypt it as a manifest (with `"dstorage:manifest:v1"`). Manifest detection is cryptographic, not JSON-shape-based.

### Storage ID format

The SDK treats `storageId` as an opaque string — the crypto layer encrypts its UTF-8 bytes (see [Wire formats](#wire-formats) above), so there is no length or format requirement at the SDK level. Today's Arweave-family adapters (`ArweaveStorageAdapter`, `ArweaveLocalStorageAdapter`, `ArweaveBundlerStorageAdapter`) all return 43-character base64url strings — 32 random bytes encoded without padding, matching the Arweave transaction ID format — but a storage adapter for a different network (e.g. an IPFS CID or another content-addressed ID) can return any string shape without requiring changes to the encryption layer.

### Key loss and data recovery

Encryption keys are derived deterministically from the encryption adapter's inputs — no key material is stored by the SDK. This means:

- **The same inputs always produce the same key**: reconnecting with the same adapter and credentials decrypts existing data transparently.
- **Losing your credentials means permanent data loss.** There is no key escrow, no recovery mechanism, and no way to decrypt data without the original inputs:
  - `PasswordEncryptionAdapter` — forgetting the password or losing the salt string makes data unrecoverable.
  - `MnemonicEncryptionAdapter` / wallet providers — losing the seed phrase or private key has the same effect. Follow standard seed-phrase backup practices.
  - `KeypairEncryptionAdapter` — if created with `generateKeypair()`, losing the SK bytes makes data unrecoverable. If created deterministically via `fromPassword()` or `fromMnemonic()`, the keypair can be re-derived from the original inputs.
  - `WebAuthnPrfEncryptionAdapter` — losing the passkey (the device, or the physical security key) without another registered credential or platform sync makes data unrecoverable. Platform passkeys that sync via the OS's passkey manager (iCloud Keychain, Google Password Manager) provide recovery across the user's own devices; a roaming hardware key has no such sync — register a second key as a backup if you rely on one.

### Cryptographic primitives

Quick reference for all hash functions and KDFs used across the SDK:

| Algorithm          | Library / source       | Used for                                                                                                                                                                                                                                   | PQ-safe            |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| **BLAKE3**         | `@noble/hashes/blake3` | Content hash stored on-chain; verified on every `retrieve()` call to detect storage-layer tampering                                                                                                                                        | ✅ Yes (symmetric) |
| **HKDF-SHA-256**   | Web Crypto API         | KEK derivation from adapter seed; `ownerSecret` derivation (`HKDF(dek, storageId, "dstorage:owner-secret:v1")`); KEK derivation from ML-KEM shared secret; WebAuthn PRF output → 64-byte seed expansion for `WebAuthnPrfEncryptionAdapter` | ✅ Yes (symmetric) |
| **PBKDF2-SHA-512** | Web Crypto API         | BIP-39 mnemonic → 64-byte seed (standard BIP-39, 2048 iterations) — used by `MnemonicEncryptionAdapter`                                                                                                                                    | ✅ Yes (symmetric) |
| **Scrypt**         | `@noble/hashes/scrypt` | Password → 64-byte seed (memory-hard, GPU/ASIC-resistant) — used by `PasswordEncryptionAdapter` and `KeypairEncryptionAdapter.fromPassword()`                                                                                              | ✅ Yes (symmetric) |
| **SHA-256 digest** | Web Crypto API         | Owner commitment in `MockChainAdapter` only — not used in production (Midnight uses ZK proofs instead)                                                                                                                                     | ✅ Yes (symmetric) |

### Public-mode integrity

For public uploads (`isPublic: true`), the only protection against a malicious gateway
substituting the data is the `X-Content-Hash` BLAKE3 tag written to the Arweave
transaction at upload time. `ArweaveStorageAdapter` verifies this tag on every
`retrieve()` call. Private uploads have the additional guarantee of XChaCha20-Poly1305
AEAD authentication. Pass `skipIntegrityCheck: true` to the adapter to opt out of the
hash check when using a fully trusted private gateway.

---

## Supported Providers

| Area    | Provider                        | Status       | Notes                                                                                                                 |
| ------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Storage | `MockStorageAdapter`            | ✅ Live      | In-memory / `localStorage` — perfect for development & demos                                                          |
| Storage | `ArweaveLocalStorageAdapter`    | ✅ Live      | Local [arlocal](https://github.com/textury/arlocal) node for development and integration testing                      |
| Storage | `ArweaveStorageAdapter`         | ✅ Live      | Arweave mainnet; JWK wallet key (Node.js), Wander/ArConnect browser wallet, or `managedPayment`                       |
| Storage | `ArweaveBundlerStorageAdapter`  | ✅ Live      | Near-instant finality via ANS-104 bundled uploads and managed server-signing; no client AR wallet needed              |
| Chain   | `MockChainAdapter`              | ✅ Live      | Simulates on-chain references locally                                                                                 |
| Chain   | `MidnightSimulatorChainAdapter` | ✅ Live      | Runs the real `DataRegistry` circuits without a live network                                                          |
| Chain   | `MidnightChainAdapter`          | ✅ Live      | Midnight Preprod / Preview / local; connector (browser wallet) and provider (Node.js) modes                           |
| Payment | `MockPaymentAdapter`            | ✅ Simulated | Simulated by design, for development & tests                                                                          |
| Payment | `ArweavePaymentAdapter`         | ✅ Live      | Pays AR from a JWK wallet                                                                                             |
| Payment | `ManagedPaymentAdapter`         | ✅ Live      | Remote signing server (e.g. [dStorage Pro](https://dstorage.pro)); Midnight DUST fees otherwise handled by the wallet |

---

## Known Limitations

- Browser Midnight connector flows require wallet extension availability and compatible network configuration.
- **ManagedPaymentAdapter — no response MAC.**
  The signing server response (`txId`, `signature`) is validated for schema correctness and a `success: true` flag, but there is no cryptographic proof that the response originated from the legitimate signing server and was not modified in transit. The adapter relies solely on TLS for transport integrity. A network-level MITM or a compromised CDN could substitute a valid-shaped but malicious response (e.g. replacing `txId` or `signature` with attacker-controlled values) and schema validation would still pass.
  The signing key substitution attack (where a MITM replaces `publicKey` in the response to corrupt the on-chain ownership record) is mitigated: the expected RSA-4096 modulus is embedded in the auth token and pinned at construction time; each sign-tx request asserts the pinned key and the server rejects any mismatch.
  **Mitigation for the response MAC gap:** ensure `managedPayment.signingServerUrl` is always HTTPS with a valid certificate issued to the operator-controlled domain. Do not use this adapter over plain HTTP or with self-signed certificates in production.
  A proper fix requires the signing server to include an `HMAC-SHA256(sharedSecret, requestId ‖ txId ‖ signature)` MAC in its response, and the adapter to verify it before trusting any field. This is deferred pending a stable signing-server API.

---

## Demo Apps

This repository includes two demo apps that exercise the SDK end-to-end:

- **`apps/demo`** — _HealthVault_, a React + Vite web app: upload an encrypted health insurance certificate and generate a ZK proof of coverage for a verifier. Supports mock, Arweave Local, Arweave, and browser Midnight connector (Lace) paths.
- **`apps/demo-console`** — a Node.js CLI using Midnight Preprod + Arweave Local: upload files, list on-chain references, and retrieve content by `refId`.

See [CONTRIBUTING.md](CONTRIBUTING.md#running-the-demo-apps) for how to build and run them from source.

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build from source, run the unit and integration tests, and submit changes.

## Security

Please **do not** open public issues for security vulnerabilities — see [SECURITY.md](SECURITY.md) for how to report them privately.

## License

MIT — see [LICENSE](LICENSE).
