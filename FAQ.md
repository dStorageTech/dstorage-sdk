# dStorage SDK — Frequently Asked Questions

---

## Table of Contents

- [Concepts & Features](#concepts--features)
- [Developers](#developers)
- [Encryption & Security](#encryption--security)
- [Deployment & Configuration](#deployment--configuration)
- [Managed Payments & dStorage Pro](#managed-payments--dstorage-pro)
- [Troubleshooting](#troubleshooting)

---

## Concepts & Features

**What is dStorage?**

dStorage is a privacy-first SDK that combines client-side encryption, decentralised storage (Arweave), and on-chain coordination (Midnight) in a single developer-facing API. It lets dApps store sensitive user data without the operator ever seeing the plaintext.

**Who is dStorage designed for?**

Teams building privacy-sensitive dApps — health records, identity, finance, enterprise workflows — that need strong client-side confidentiality without running their own plaintext data infrastructure.

**What problem does it solve?**

Most services store user data on servers they control. Users must trust the operator not to read, sell, or lose their data. dStorage removes that requirement: data is encrypted on the user's device before it ever leaves, stored on a decentralised network, and the on-chain reference gives the owner a verifiable receipt. Operators never see the plaintext.

**What is an on-chain reference and why does it matter?**

An on-chain reference is a tamper-proof record written to the Midnight blockchain that links an owner's identity to an encrypted storage blob. It is what makes data _retrievable_ — you can look it up later with just a `refId`. The reference contains an encrypted storage pointer and a key envelope; without the owner's key neither piece reveals anything meaningful.

**What does the SDK store on-chain vs off-chain?**

- **Off-chain (Arweave)**: the encrypted data payload.
- **On-chain (Midnight DataRegistry contract)**: an encrypted storage pointer (`storageId`), an encrypted key envelope (`keyEnvelope`), the encryption scheme label, and optional public metadata. Raw user data and plaintext keys never appear on-chain.

**Can dStorage operators read my data?**

No. Encryption happens on the user's device using keys derived locally. The managed payment service (`dstorage.pro`) only receives a cryptographic hash — never content. The storage network (Arweave) holds ciphertext. No party in the pipeline holds an unencrypted copy.

**What is a `refId`?**

A `refId` is a 32-byte identifier (returned as a hex string) produced by the Midnight `DataRegistry` contract when a reference is stored. Pass it to `retrieveByRefId()` to look up and decrypt the data later. It is the primary retrieval handle; `storageId` is a lower-level identifier for the raw storage blob.

**What is a `storageId`?**

A 43-character base64url string (32 decoded bytes) that identifies the encrypted blob on the storage network. For chunked uploads it points to the manifest, not individual chunks. You can retrieve directly via `retrieveByStorageId()` but this bypasses the on-chain record — useful for direct storage access when no chain adapter is configured.

**Does dStorage work without a blockchain?**

Yes. Omit `chainAdapter` from `DStorageConfig` to run in storage-only mode. Uploads go directly to the storage network; no on-chain reference is written. `store()` still returns a `storageId` for later retrieval, but there is no verifiable on-chain ownership record.

**Does dStorage support large files?**

Yes. Files larger than 10 MB are automatically split into independently encrypted 10 MB chunks. A small manifest ties them together; the manifest's `storageId` is the single pointer written on-chain. `store()`, `retrieveByRefId()`, and `retrieveByStorageId()` behave identically regardless of file size.

**What networks and storage providers are supported today?**

| Area    | Available now                                             | Stub / planned |
| ------- | --------------------------------------------------------- | -------------- |
| Storage | Mock, Arweave Local, Arweave, Arweave Turbo (managed)     |
| Chain   | Mock, MockMidnight, Midnight (connector + provider modes) |
| Payment | Mock, Arweave (JWK), Managed (remote signing server)      |

**What tokens are used for payments?**

| Token  | Network  | Used for                                                    |
| ------ | -------- | ----------------------------------------------------------- |
| `AR`   | Arweave  | Storage payment via `ArweavePaymentAdapter` or managed flow |
| `DUST` | Midnight | Chain fees — handled internally by the Midnight wallet      |
| `MOCK` | Mock     | Development & testing (simulated, no real funds needed)     |

**What does `isPublic: true` do?**

It is an explicit opt-in that skips both encryption layers. The data payload is stored as raw bytes; the `storageId` is written to the chain in plaintext. Use it only for world-readable content. **Public mode is permanent and irreversible** — once data is stored unencrypted on Arweave it cannot be made private retroactively.

---

## Developers

**What is the minimal working setup?**

```typescript
import {
  DStorage,
  MockStorageAdapter,
  MockChainAdapter,
  PasswordEncryptionAdapter,
} from "@dstorage-tech/dstorage";

const sdk = new DStorage({
  storageAdapter: new MockStorageAdapter(),
  chainAdapter: new MockChainAdapter(),
  encryptionAdapters: [
    new PasswordEncryptionAdapter({
      password: "Correct-Horse-Battery!",
      salt: "myapp:v1",
    }),
  ],
});
await sdk.init();
const { chainRefId } = await sdk.store(new TextEncoder().encode("hello"));
const { bytes } = await sdk.retrieveByRefId(chainRefId);
```

Mock adapters are fully in-memory — no network, no Docker, no tokens required.

**What does `sdk.init()` do?**

`init()` prepares the SDK for use: it derives the chain encryption key and, if a `chainAdapter` is configured, calls `chainAdapter.init()` which either deploys a new `DataRegistry` contract or joins an existing one. You must call `init()` before `store()` or `retrieveByRefId()` when using private (encrypted) data.

**Should I call `sdk.destroy()` when I'm done, and why?**

Yes, calling `destroy()` is strongly recommended whenever the user logs out, navigates away, or the SDK instance is no longer needed. It immediately wipes all sensitive in-memory state:

- **Encryption providers** — the live `EncryptionAdapter` instances holding derived KEKs
- **Wallet reference** — the in-memory wallet info including the raw seed used to derive keys
- **Initialized flag** — prevents accidental further use of a stale instance

Without an explicit `destroy()` call, this material stays in the JavaScript heap for the lifetime of the process or page. In a browser context that means it persists across route changes and is accessible to any code running in the same tab. In a Node.js server context it stays in memory for the lifetime of the process, potentially across multiple users' sessions if the instance is inadvertently shared.

```typescript
// React example — destroy on logout or unmount
useEffect(() => {
  return () => sdk.destroy();
}, []);

// or on explicit logout
function handleLogout() {
  sdk.destroy();
  router.push("/login");
}
```

`destroy()` does not delete any on-chain data or stored content — it only clears the local key material. You can call `init()` again on the same instance to reinitialise if needed.

**How do I preserve a deployed contract address across runs?**

`init()` returns the `contractAddress` of the deployed (or joined) `DataRegistry` contract. Save it and pass it as `contractAddress` to `MidnightChainAdapter` on subsequent runs to reconnect instead of deploying a new one each time.

**Can I estimate costs before uploading?**

Yes:

```typescript
const estimate = await sdk.estimateCost(bytes.byteLength);
// { storageCost: { amount, token }, chainCost: { amount, token }, fileSizeBytes }
```

`executeMetaTransaction()` is a higher-level wrapper that runs the entire pipeline (estimate → encrypt → pay → upload → write reference) and emits progress events at each step.

**How do I pass metadata to an upload?**

Use the second argument to `store()`:

```typescript
await sdk.store(bytes, {
  metadata: { filename: "report.pdf", mimeType: "application/pdf" },
  onProgress: ({ phase, chunksUploaded, totalChunks }) => {
    /* … */
  },
});
```

Metadata is stored alongside the on-chain reference and returned during retrieval.

**How do I run tests?**

```sh
npm test          # unit tests — fully in-memory, no network required
npm run test:integration  # integration tests — requires arlocal (+ proof server for Midnight suite)
```

Unit tests use `MockStorageAdapter`, `MockChainAdapter`, and fast scrypt params so the suite completes in seconds. Integration tests are skipped gracefully when the required services are not running.

**How do I run only a single integration suite?**

```sh
npm run test:integration -- -t "arlocal only"
npm run test:integration -- -t "multi-key wrapping"
npm run test:integration -- -t "full stack"
```

**What scrypt params should I use in tests?**

```typescript
new PasswordEncryptionAdapter({
  password: "dstorage-test-passphrase-v1!",
  salt: "test-salt",
  params: { N: 1024, r: 8, p: 1 }, // fast for tests — never use in production
});
```

**What is the build order for packages?**

```
crypto → encryption → payment → storage → chain → core
```

Run `npm run build` from the repo root — it respects this order. After modifying any package source, rebuild before running the demo apps.

**Can I integrate dStorage into an existing Midnight app?**

Yes. See `QUICK_START.md` for a step-by-step guide that wires dStorage into the [Midnight Bulletin Board](https://github.com/midnightntwrk/example-bboard) example app, reusing its existing wallet and proof server.

**What is `executeMetaTransaction()` and when should I use it?**

It is a convenience wrapper that runs the full upload pipeline atomically and fires a progress callback at each step (`estimate` → `encrypt` → `payment_storage` → `upload` → `chain_reference` → `complete`). Use it when you want a single entry point and progress reporting. Use `store()` directly when you need fine-grained control.

**What Node.js version is required?**

Node.js 22 or later.

**Does the SDK work in the browser?**

Yes, with some constraints. Use the browser entry point (`@dstorage/chain/browser`) which excludes Node.js-only adapters. Set `walletMode: "connector"` in `MidnightChainAdapter` to use the Lace browser extension. Pass `zkConfigBaseUrl: window.location.origin` so ZK artifacts are fetched over HTTP from the `public/` directory rather than read from disk.

---

## Encryption & Security

**What encryption scheme does the SDK use?**

XChaCha20-Poly1305 with a 24-byte random nonce. Its 192-bit nonce space pushes the birthday bound to 2⁸⁰, making random nonce collision a non-issue in practice.

**What is the DEK/KEK model?**

A fresh random **Data Encryption Key (DEK)** is generated per upload. The DEK is then wrapped (encrypted) under each adapter's **Key Encryption Key (KEK)** and stored in the `keyEnvelope` field on-chain. To decrypt, the SDK retrieves the key envelope, uses one of the registered adapters to unwrap the DEK, then decrypts the payload.

**What encryption adapters are available?**

| Adapter                     | Key source                           | Post-quantum at key layer       | Cross-device portable                                             |
| --------------------------- | ------------------------------------ | ------------------------------- | ----------------------------------------------------------------- |
| `PasswordEncryptionAdapter` | scrypt(password, salt)               | Conditional on password entropy | Yes — same password + salt on any device                          |
| `MnemonicEncryptionAdapter` | BIP-39 (24-word) or 64-byte hex seed | 128-bit PQ (unconditional)      | Yes — same mnemonic on any device                                 |
| `KeypairEncryptionAdapter`  | ML-KEM768 public/secret keypair      | 192-bit PQ (unconditional)      | Requires SK; re-derivable via `fromPassword()` / `fromMnemonic()` |

**Why does `MnemonicEncryptionAdapter` require 24 words?**

A 12-word BIP-39 mnemonic provides only 128 bits of entropy, which Grover's algorithm halves to 64-bit post-quantum security — below NIST's 128-bit minimum. The adapter rejects anything shorter than 24 words at construction time.

**Can multiple adapters decrypt the same upload?**

Yes. Supply an array to `encryptionAdapters`. The SDK wraps the DEK under every adapter's KEK independently. Any single registered adapter can decrypt any upload made while it was in the list. This is useful for adding a recovery key or shared access:

```typescript
encryptionAdapters: [
  new PasswordEncryptionAdapter({ password, salt }), // primary
  new MnemonicEncryptionAdapter({ mnemonic: backupPhrase }), // recovery
];
```

**What happens if I lose my encryption key / password?**

Data is permanently unrecoverable. The SDK stores no key material — keys are derived deterministically from the adapter's inputs each time. There is no key escrow or recovery mechanism. Follow standard backup practices for whichever secret your adapter uses (password + salt, BIP-39 mnemonic, or SK bytes).

**Is `PasswordEncryptionAdapter` post-quantum safe?**

At the data layer, yes — XChaCha20-Poly1305 with a 256-bit key gives 128-bit post-quantum security (NIST minimum). At the key encapsulation layer, it depends on password entropy. Human-chosen passwords cannot reach the 256-bit entropy required to resist Grover's. To close this gap, use `generatePqsPassword()` with `KeypairEncryptionAdapter.fromPassword()`, or switch to `MnemonicEncryptionAdapter` (24 words).

**What is `generatePqsPassword()`?**

A helper that produces a cryptographically random 43-character base64url string (32 bytes = 256 bits of real entropy). Pass the result to `KeypairEncryptionAdapter.fromPassword()` to get full ML-KEM PQ protection without manual key storage. Store the generated string — it is the only secret needed to re-derive the keypair.

**What makes a password acceptable to `PasswordEncryptionAdapter`?**

The adapter enforces four rules at construction time:

1. **Length** — at least 12 characters (configurable via `minPasswordLength`).
2. **Character diversity** — at least 3 of 4 character classes: uppercase, lowercase, digits, special characters.
3. **No sequential runs** — patterns like `abcde` or `12345` are rejected.
4. **No keyboard-walk patterns** — sequences like `qwerty` or `asdfg` are rejected.
5. **Entropy** — charset-based entropy estimate must reach 60 bits (configurable via `minEntropyBits`).

If your use case requires bypassing these checks — for example, a machine-generated credential — use `generatePqsPassword()` to obtain a cryptographically random 43-character base64url string (256 bits of real entropy), then pass it to `KeypairEncryptionAdapter.fromPassword()` for full ML-KEM PQ protection.

**How does the SDK prevent swapping chunks or blobs in transit?**

Each ciphertext is bound to its role via Additional Authenticated Data (AAD). Labels used:

| Label                       | Protects                                |
| --------------------------- | --------------------------------------- |
| `dstorage:payload:v1`       | Single-shot (non-chunked) uploads       |
| `dstorage:manifest:v1`      | Chunked upload manifest                 |
| `dstorage:chunk:v1:<i>/<n>` | Each chunk bound to its index and total |
| `dstorage:storageId:v1`     | Storage pointer encrypted on-chain      |

A reordered chunk, a substituted manifest, or a ciphertext moved from one role to another causes MAC verification to fail before any data is returned.

**How does the SDK verify that an Arweave gateway hasn't tampered with the retrieved data?**

Every Arweave transaction includes an `X-Content-Hash` tag containing the BLAKE3 hex digest of the uploaded bytes (ciphertext for private uploads, plaintext for public ones). On retrieval, `ArweaveStorageAdapter` fetches the transaction metadata, recomputes the hash, and throws `[dStorage/arweave] Content hash mismatch` if they differ.

For private uploads this is defence-in-depth on top of XChaCha20-Poly1305 AEAD authentication. For public uploads it is the primary integrity guarantee.

To opt out when using a fully trusted private gateway, pass `skipIntegrityCheck: true` to `ArweaveStorageAdapter`.

**Is the storage pointer on-chain encrypted?**

Yes. The `storageId` (the Arweave content address) is encrypted with the same per-upload DEK using a fresh nonce, then stored in the `DataRegistry` contract. A blockchain observer cannot learn which storage resource belongs to which wallet even though the on-chain record is public.

**What is `ownerSecret` and why is it not stored?**

`ownerSecret` is an HKDF derivative of the DEK and the raw `storageId`. It is needed to remove or update a reference on-chain. Because it is derived deterministically from values the SDK already holds, it never needs to be persisted — it is recomputed on demand during `removeReference()`.

---

## Deployment & Configuration

**What are the prerequisites for running the SDK locally?**

- Node.js 22+, npm
- Docker (for Midnight proof server and Arweave Local)
- Midnight Compact compiler v0.30.0 (for recompiling the contract)
- Lace wallet extension ≥ 1.36.2 (browser connector flows only)
- Wander wallet extension (Arweave browser flows only)

**How do I start the local Midnight proof server?**

```sh
docker run -p 6300:6300 midnightntwrk/proof-server:8.0.3 -- midnight-proof-server -v
```

**How do I start a local Arweave node for testing?**

```sh
docker run -d --rm -p 1984:1984 textury/arlocal
# or: npx arlocal
```

No real AR tokens are needed — arlocal auto-funds test wallets.

**What Midnight networks does the adapter support?**

The `MidnightChainAdapter` supports `undeployed` (localhost) and `preprod`.

**How do I configure `MidnightChainAdapter` for browser vs Node.js?**

Use the `walletMode` discriminated union:

```typescript
// Node.js (provider mode) — caller supplies a pre-built, synced WalletFacade
{
  walletMode: "provider",
  walletProvider,       // AdapterWalletProvider built and synced by the app
  privateStatePassword, // password for local LevelDB state encryption
  zkArtifactsPath,      // optional: absolute path to keys/ and zkir/ dirs
}

// Browser (connector mode) — delegates to a wallet extension (Lace)
{ walletMode: "connector", connectorName: "mnLace", zkConfigBaseUrl: window.location.origin }
```

`walletMode` is required. See `QUICK_START.md` for a complete provider-mode setup example.

**How do I configure ArweaveTurbo for managed uploads?**

```typescript
new ArweaveTurboStorageAdapter({
  signingServerUrl: "https://dstorage.pro",
  // Token format: <credential>.<base64url_modulus> — issued by the signing server.
  // The modulus (512 bytes, base64url) is the server's RSA-4096 public key and is
  // used to pin the expected signing key at construction time.
  authToken: process.env.DSTORAGE_AUTH_TOKEN ?? "",
});
```

**How do I reuse an existing DataRegistry contract?**

Pass the previously deployed address:

```typescript
new MidnightChainAdapter({
  contractAddress: "02abc123…",
  // … rest of config
});
```

Omit `contractAddress` to deploy a new contract on first `init()`.

**Where do ZK artifacts live and how are they served?**

- **Node.js**: pass an absolute path via `zkArtifactsPath`. The adapter reads `keys/` and `zkir/` from that directory.
- **Browser**: copy `keys/` and `zkir/` into your application's public assets directory, then pass `zkConfigBaseUrl: window.location.origin`. Artifacts are fetched over HTTP.

**What environment variables does the integration test suite need?**

Copy `tests/integration/env.example` to `.env.integration` and fill in:

| Variable                       | Required               | Default                 | Purpose                                                                             |
| ------------------------------ | ---------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `INTEGRATION_SEED`             | Yes (full-stack suite) | —                       | 24-word BIP-39 mnemonic or 128-char (64-byte) hex seed for a funded Midnight wallet |
| `INTEGRATION_CONTRACT_ADDRESS` | No                     | deploys fresh           | Reuse an existing DataRegistry to skip slow deployment                              |
| `ARLOCAL_URL`                  | No                     | `http://localhost:1984` | Arweave Local endpoint                                                              |
| `PROOF_SERVER_URL`             | No                     | `http://localhost:6300` | Midnight proof server endpoint                                                      |

**Can I skip integration services in CI?**

Yes. If arlocal or the proof server is not running, those suites are skipped rather than failed. The unit test suite (`npm test`) never requires external services.

---

## Managed Payments & dStorage Pro

**What is dStorage Pro?**

dStorage Pro (`https://dstorage.pro`) is a managed service that handles storage and chain payment signing on behalf of applications. Instead of requiring every end-user to hold AR tokens and manage an Arweave JWK wallet, the service signs and submits transactions server-side. Developers sign up for an API auth token and configure the SDK to point at the service URL — no client-side wallet management required.

**What does the managed service see?**

Only a cryptographic hash of the content and the request metadata needed to construct the transaction. It never receives the plaintext payload or encryption keys. Encryption happens entirely on the user's device before the SDK makes any network call.

**How do I configure the managed payment flow?**

Pass `signingServerUrl` and `authToken` to `ArweaveTurboStorageAdapter`:

```typescript
import {
  DStorage,
  ArweaveTurboStorageAdapter,
  MidnightChainAdapter,
} from "@dstorage-tech/dstorage";

const sdk = new DStorage({
  storageAdapter: new ArweaveTurboStorageAdapter({
    signingServerUrl:
      process.env.DSTORAGE_SERVICE_URL ?? "https://dstorage.pro",
    authToken: process.env.DSTORAGE_AUTH_TOKEN ?? "",
  }),
  chainAdapter: new MidnightChainAdapter({
    // … chain config …
    signingServerUrl:
      process.env.DSTORAGE_SERVICE_URL ?? "https://dstorage.pro",
    authToken: process.env.DSTORAGE_AUTH_TOKEN ?? "",
  }),
  encryptionAdapters: [
    /* … */
  ],
});
```

Both the storage adapter and the chain adapter accept `signingServerUrl` / `authToken`. Prefer environment variables over hard-coding credentials.

**Where do I get an auth token?**

Sign up at [dstorage.pro](https://dstorage.pro). Tokens use a compound format:

```
<credential>.<base64url_modulus>
```

`<credential>` is the authentication secret sent as the Bearer header. `<base64url_modulus>` is the 512-byte RSA-4096 public key modulus of the server's Arweave signing key, base64url-encoded (~683 chars). The adapter parses and pins this key at construction time — if the server rotates its signing key the token must be re-issued to reflect the new modulus.

**How do I set the credentials via environment variables?**

```sh
export DSTORAGE_SERVICE_URL=https://dstorage.pro
export DSTORAGE_AUTH_TOKEN=ds_your_token_here
```

Or add them to a `.env` file in your project root (loaded via `dotenv` or equivalent). The SDK does not load `.env` files automatically — your application loader must do that.

**What is `ArweaveTurboStorageAdapter` and how does it differ from `ArweaveStorageAdapter`?**

`ArweaveTurboStorageAdapter` uses the Arweave Turbo upload protocol routed through the dStorage Pro signing server. Uploads reach near-instant finality and require no client-side AR wallet or JWK key file. `ArweaveStorageAdapter` requires the caller to hold a funded Arweave JWK wallet and signs transactions locally.

**What does the managed Midnight chain payment flow look like?**

For Midnight, fees (DUST) are handled internally by the wallet — the Midnight adapter does not use the managed payment service for chain fees. The managed service is used for Arweave storage costs only. On Midnight, configure `MidnightChainAdapter` with `signingServerUrl` and `authToken` so the SDK can route any required server-side calls through dStorage Pro; the wallet still signs the on-chain transaction.

**Does the managed service support the bboard quick-start example?**

Yes — the QUICK_START guide is built around the managed flow. `ArweaveTurboStorageAdapter` + `MidnightChainAdapter` in provider-wallet mode both accept `signingServerUrl` / `authToken` and reuse bboard's existing wallet and proof server. No separate AR wallet is needed.

**Is there a known security limitation with the managed payment response?**

The signing server response (`txId`, `signature`) is validated for schema correctness but carries no cryptographic MAC. The adapter relies on TLS for transport integrity. A compromised CDN or network-level MITM could substitute a valid-shaped response and schema validation would still pass.

The signing key substitution attack (where a MITM replaces the server's public key to corrupt the on-chain ownership record) is mitigated: the expected key is embedded in the auth token and pinned at construction time. Each sign-tx request asserts the pinned key; the server rejects any mismatch.

**Mitigation for the response MAC gap**: always use `signingServerUrl` with HTTPS and a valid certificate issued to the operator-controlled domain. Never use this adapter over plain HTTP or with self-signed certificates in production. A proper fix (an `HMAC-SHA256` response MAC) is deferred pending a stable signing-server API.

**What payment tokens does the managed service handle?**

The managed service covers Arweave storage costs billed in AR. Midnight chain fees (DUST) remain the responsibility of the wallet configured in `MidnightChainAdapter`.

**How do I test the managed payment code path without real dStorage Pro credentials?**

Use `MockStorageAdapter` and `MockMidnightChainAdapter` with `signingServerUrl` and `authToken` pointing at a local signing server (or any reachable test endpoint). Both adapters automatically use the `managedmock` payment network, which sends the network identifier `"TEST"` to the server instead of `"arweave_turbo"` or `"midnight"`. This exercises the full managed payment request/response round-trip — including auth token pinning and error handling — without touching real funds or the production signing server.

```typescript
const sdk = new DStorage({
  storageAdapter: new MockStorageAdapter({
    signingServerUrl: "http://localhost:3000",
    authToken: process.env.DSTORAGE_TEST_TOKEN ?? "",
  }),
  chainAdapter: new MockMidnightChainAdapter({
    signingServerUrl: "http://localhost:3000",
    authToken: process.env.DSTORAGE_TEST_TOKEN ?? "",
  }),
  encryptionAdapters: [
    /* … */
  ],
});
```

---

## Troubleshooting

**`Maximum call stack size exceeded` when encrypting files**

Caused by spreading large `Uint8Array` values into `String.fromCharCode()`. This was fixed in the SDK by processing the buffer in 8 KB chunks. Ensure you are on a version that includes this fix.

**`Failed to parse result provided by node` / `instanceof BN` failure**

`bn.js@5.2.3` appears more than once in `node_modules` — `instanceof BN` fails across module boundaries. Fix: pin `bn.js@5.2.3` in root `package.json` `dependencies` and delete any nested copies under `node_modules`. Run `npm install` afterwards.

**`Invalid URL` instead of an `init()` error**

The chain adapter's `_getAPI()` is called before `init()` completes, hitting an endpoint that has no URL yet. Make sure `await sdk.init()` resolves fully before any `store()` or `retrieve*()` call.

**ZK artifacts not found / `Invalid URL` at runtime**

- **Node.js**: verify `zkArtifactsPath` points to the directory containing `keys/` and `zkir/` sub-directories, not to a JS file or parent directory.
- **Browser**: confirm the artifacts were copied into `public/` and that `zkConfigBaseUrl` is set.

**`ledger-v8` type conflicts**

`ledger-v8` must be pinned to `8.0.3` in the chain package. Versions `8.0.x` above that or mismatched peer dependencies cause type incompatibilities. Check `packages/chain/package.json` and the root lockfile.

**Wallet extension not detected in browser connector mode**

Confirm the Lace extension (≥ 1.36.2) is installed and enabled in your browser. The connector flow calls `window.midnight.mnLace.enable()` — if the extension is absent or not enabled the call rejects. Reload the page after installing/enabling the extension.

**Integration tests stall or never complete**

Check that the required Docker containers are running (`docker ps`). Confirm port availability: arlocal on 1984, proof server on 6300. The Midnight full-stack suite generates ZK proofs which can take 30–90 seconds each — this is expected.

**How do I reuse a deployed DataRegistry contract across integration test runs?**

On the first run, copy the contract address printed in the test output, then add it to `.env.integration`:

```
INTEGRATION_CONTRACT_ADDRESS=02abc123…
```

Subsequent runs will join the existing contract, skipping the slow deployment step.
