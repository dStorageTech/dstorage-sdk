<img src="docs/dStorage-logo-image-monochrome.png" alt="dStorage logo" width="80" />

# dStorage SDK

> Privacy-first data layer for dApps — client-side encryption + decentralised storage + on-chain coordination in a single SDK.

For teams building privacy-sensitive dApps (health, identity, finance, and enterprise workflows) that need strong client-side confidentiality without operating plaintext data infrastructure.

## Table of Contents

- [Mission](#mission)
- [Quick Start](#quick-start)
- [Browser Bundle](#browser-bundle)
- [Testing](#testing)
- [Reality Check (Current Support)](#reality-check-current-support)
- [Payments](#payments)
- [Architecture](#architecture)
- [Encryption Notes](#encryption-notes)
- [Supported Providers](#supported-providers)
- [Known Limitations](#known-limitations)
- [Publishing](#publishing)
- [License](#license)

## Mission

Deliver a **privacy-first, developer-friendly data layer** combining **Midnight privacy infrastructure** with **permanent decentralized storage**, enabling applications to handle sensitive user data securely **without centralized custody** — client-side encryption, decentralised storage, and on-chain coordination in a single SDK.

For the full usage guide, API reference, and encryption architecture, see
[`packages/core/README.md`](packages/core/README.md) — that's the README published
alongside the `@dstorage-tech/dstorage-sdk` npm package and the one kept current with
its API. This root README covers the monorepo/contributor workflow instead: building
from source, running the demo apps, and the test/publish process.

---

## Quick Start

These setup steps are mainly for the current monorepo/development workflow and are temporary. Once the SDK is published as installable packages, most of the manual build and local wiring steps below will no longer be required for standard integration and usage.

### Prerequisites

- Node.js 22+ and npm (Download from [nodejs.org](nodejs.org))
- Docker for Midnight Proof server and Arweave local (Download from [docker.com/get-started](https://www.docker.com/get-started))
- Midnight [Compact developer tools](https://docs.midnight.network/blog/compact-developer-tools) — **version 0.31.1 required** (the ZK artifacts in this repository were built against that version)
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
# Compact v0.31.1 matching the committed contract artifacts
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/download/v0.31.1/compact-installer.sh | sh
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
docker run -p 6300:6300 midnightntwrk/proof-server:8.1.0 -- midnight-proof-server -v
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

## Browser Bundle

The SDK ships a pre-built ESM bundle that includes all browser-safe adapters. It is not minified — minification strips the `/* @vite-ignore */` comments that tell a bundler to skip static analysis of Node-only code paths (e.g. `MidnightChainAdapter`'s facade/provider mode, which dynamically imports `fs`), so those comments have to survive intact in the shipped file. Those Node-only paths are present in the bundle but unreachable in connector mode.

### Generating the bundle

The browser bundle is produced automatically as part of the normal build:

```sh
npm run build
```

After the build, the bundle is available at:

```
packages/core/dist/browser.mjs   — ESM, ready to import
packages/core/dist/browser.d.mts — TypeScript declarations
```

### Using the bundle

**Option 1 — Explicit subpath import (recommended for bundler-based projects)**

Install the package, then import from the `/browser` subpath:

```typescript
import {
  DStorage,
  ArweaveStorageAdapter,
  ArweavePaymentAdapter,
  MidnightChainAdapter,
} from "@dstorage-tech/dstorage-sdk/browser";
```

Works with Vite, webpack, rollup, esbuild, or any other bundler. All adapters' dependencies (`arweave`, `@midnight-ntwrk/*`, `@dha-team/arbundles`, etc.) are real dependencies of `@dstorage-tech/dstorage-sdk` — `npm install @dstorage-tech/dstorage-sdk` alone pulls in everything, nothing extra to install.

**Option 2 — Auto-resolution via the `"browser"` condition (zero config)**

When a bundler is configured for a browser target it automatically honours the `"browser"` condition in `package.json` exports. No subpath needed — normal imports just work:

```typescript
import { DStorage } from "@dstorage-tech/dstorage-sdk";
// bundler auto-selects the browser-safe chain entry for @dstorage/chain
```

**Option 3 — Direct `<script type="module">` or CDN**

Reference `dist/browser.mjs` directly, or serve it from a CDN that supports import maps:

```html
<script type="module">
  import {
    DStorage,
    ArweaveStorageAdapter,
  } from "./vendor/dstorage/browser.mjs";
</script>
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

## Testing

### Unit tests

The unit test suite uses fully in-memory mocks (no network, no Docker). Run it with:

```sh
npm test
```

### Integration tests

Integration tests exercise real network adapters end-to-end:

- **arlocal-only suite** — `ArweaveLocalStorageAdapter` against a local arlocal node with `MidnightSimulatorChainAdapter`
- **multi-key wrapping suite** — uploads encrypted with two encryption adapters verified against real arlocal storage; each adapter independently decrypts and an unrelated adapter is rejected
- **full-stack suite** — `ArweaveLocalStorageAdapter` + `MidnightChainAdapter` with ZK proofs against Midnight Preprod (or a local node); includes wallet-isolation test verifying that a different encryption adapter cannot decrypt another user's private references
- **bundler suite** — `ArweaveBundlerStorageAdapter` against a local mock signing/bundler server (relays uploads into real arlocal transactions; retrieval also goes through arlocal directly); fully local/offline, same scenario coverage as the arlocal-only, storage-only, content-hash, and tags suites

#### Prerequisites

Start the required services:

```sh
# Arweave Local (required for all suites, including the bundler suite)
docker run -d --rm -p 1984:1984 textury/arlocal

# Midnight Proof Server (required for the full-stack suite)
docker run -d --rm -p 6300:6300 midnightntwrk/proof-server:8.1.0 -- midnight-proof-server -v

# Bundler mock server (required only for the bundler suite) — separate terminal:
npm run bundler-mock:run
```

`npm run bundler-mock:run` prints an `INTEGRATION_BUNDLER_AUTH_TOKEN` on boot — copy it into `.env.integration`.

#### Configuration

Copy the example env file and fill in your values:

```sh
cp tests/integration/env.example .env.integration
```

The only required variable for the full-stack suite is `INTEGRATION_SEED` — a BIP-39 mnemonic or 64-char hex seed for a Midnight Preprod wallet funded with NIGHT and DUST tokens (see [Prerequisites](#prerequisites) for faucet links). All other variables have defaults that match the Docker commands above.

The bundler suite additionally requires `INTEGRATION_BUNDLER_AUTH_TOKEN` (printed by `npm run bundler-mock:run`) and depends on `INTEGRATION_BUNDLER_MOCK_SERVER_URL` (defaults to `http://localhost:8901`, matching the mock server's default port). Leave `INTEGRATION_BUNDLER_AUTH_TOKEN` unset to skip the bundler suite.

#### Run

```sh
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

# Run only the bundler suite
npm run test:integration -- -t "bundler"

# Run a single test by name
npm run test:integration -- -t "uploads and retrieves private data"
```

---

## Reality Check (Current Support)

| Area             | Current state                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Storage adapters | `Mock`, `ArweaveLocal`, and `Arweave` are live; `ArweaveBundler` (ANS-104 bundled uploads, managed server-signing) is live                |
| Chain adapters   | `Mock`, `MidnightSimulator`, and `Midnight` (connector + facade modes) are implemented                                                    |
| Payment adapters | `Mock` is simulated by design; `Arweave` is live (JWK wallet); `Managed` (remote signing server) is live; Midnight fees handled by wallet |
| Demo webapp      | End-to-end upload UX; supports mock, browser Midnight connector, Arweave, and Arweave Local paths                                         |
| Console demo     | Uses Midnight Preprod chain + local Arweave flow for upload/list/retrieve operations                                                      |

---

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
real dependencies of the published package — see [Browser Bundle](#browser-bundle).)

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

## Encryption Notes

Full encryption architecture (scheme, key derivation, wire formats, post-quantum
adapters, tamper detection, etc.) lives in
[`packages/core/README.md`](packages/core/README.md#encryption-design). Two things
from here aren't covered there:

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

### Storage

| Provider                   | Status  | Notes                                                                                                    |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| Mock (localStorage/memory) | ✅ Live | Perfect for development & demos                                                                          |
| Arweave Local              | ✅ Live | Local arlocal integration testing                                                                        |
| Arweave                    | ✅ Live | Requires `arweave` package + Wander wallet                                                               |
| Arweave Bundler            | ✅ Live | Near-instant finality via ANS-104 bundled uploads and managed server-signing; no client AR wallet needed |

### Blockchain

| Chain             | Status  | Notes                                                                            |
| ----------------- | ------- | -------------------------------------------------------------------------------- |
| Mock              | ✅ Live | Simulates on-chain references locally                                            |
| MidnightSimulator | ✅ Live | Simulated Midnight chain; runs real DataRegistry circuits without a live network |
| Midnight          | ✅ Live | Connector + facade modes supported                                               |

---

## Known Limitations

- Browser Midnight connector flows require wallet extension availability and compatible network configuration.
- **ManagedPaymentAdapter — no response MAC.**
  The signing server response (`txId`, `signature`) is validated for schema correctness and a `success: true` flag, but there is no cryptographic proof that the response originated from the legitimate signing server and was not modified in transit. The adapter relies solely on TLS for transport integrity. A network-level MITM or a compromised CDN could substitute a valid-shaped but malicious response (e.g. replacing `txId` or `signature` with attacker-controlled values) and schema validation would still pass.
  The signing key substitution attack (where a MITM replaces `publicKey` in the response to corrupt the on-chain ownership record) is mitigated: the expected RSA-4096 modulus is embedded in the auth token and pinned at construction time; each sign-tx request asserts the pinned key and the server rejects any mismatch.
  **Mitigation for the response MAC gap:** ensure `managedPayment.signingServerUrl` is always HTTPS with a valid certificate issued to the operator-controlled domain. Do not use this adapter over plain HTTP or with self-signed certificates in production.
  A proper fix requires the signing server to include an `HMAC-SHA256(sharedSecret, requestId ‖ txId ‖ signature)` MAC in its response, and the adapter to verify it before trusting any field. This is deferred pending a stable signing-server API.

---

## Publishing

Only `packages/core` is published to npm, as **`@dstorage-tech/dstorage-sdk`** — the other 5 workspace packages (`crypto`, `encryption`, `payment`, `storage`, `chain`) are internal build-time sources bundled inline into `packages/core`'s output; they are never published standalone. There is no CI publish workflow — `.github/workflows/ci.yml` and `integration.yml` only build and test. Releasing is a manual process:

1. **Log in to npm.** You must be a member of the `@dstorage-tech` npm org:

   ```sh
   npm login
   ```

2. **Bump the version.** `packages/core/package.json`'s `"version"` field is the one that matters — it's the only package that gets published. Either edit it directly, or from the repo root:

   ```sh
   npm run version:bump
   ```

3. **Build.**

   ```sh
   npm run build
   ```

4. **Sanity-check the tarball contents** before publishing for real:

   ```sh
   cd packages/core && npm pack --dry-run
   ```

5. **Publish.** `publishConfig.access: "public"` is already set in `packages/core/package.json`, so no `--access` flag is needed:

   ```sh
   cd packages/core && npm publish
   ```

6. **Tag and push the release:**

   ```sh
   git tag v<version> && git push origin v<version>
   ```

   Optionally cut a GitHub release from that tag.

---

## License

MIT — see [LICENSE](LICENSE).
