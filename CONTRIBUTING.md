# Contributing to dStorage SDK

Thanks for your interest in contributing! This guide covers building the SDK from source, running the demo apps and tests, and the release process.

- **Bugs and feature requests**: open a [GitHub issue](https://github.com/dStorageTech/dstorage-sdk/issues).
- **Security vulnerabilities**: do **not** open a public issue — see [SECURITY.md](SECURITY.md).
- **Using the SDK** (not developing it): you don't need anything here — `npm install @dstorage-tech/dstorage-sdk` and see the [README](README.md).

## Table of Contents

- [Repository layout](#repository-layout)
- [Development setup](#development-setup)
- [Running the demo apps](#running-the-demo-apps)
- [Testing](#testing)
- [Code conventions](#code-conventions)
- [Submitting changes](#submitting-changes)
- [Releasing](#releasing)

---

## Repository layout

This is an npm workspace monorepo:

| Path                  | Contents                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/crypto`     | Encryption primitives and key derivation — no network, no wallet state                           |
| `packages/encryption` | Encryption adapters (password, mnemonic, ML-KEM keypair, WebAuthn PRF)                           |
| `packages/payment`    | Payment adapters (Mock, Arweave, Managed)                                                        |
| `packages/storage`    | Storage adapters (Mock, Arweave Local, Arweave, Arweave Bundler) — only ever see encrypted bytes |
| `packages/chain`      | Chain adapters (Mock, MidnightSimulator, Midnight) and the `DataRegistry` Compact contract       |
| `packages/core`       | `DStorage` — wires everything together; the only package published to npm                        |
| `apps/demo`           | HealthVault React + Vite demo                                                                    |
| `apps/demo-console`   | Node.js CLI demo against Midnight Preprod                                                        |
| `tests/integration`   | Integration tests against arlocal / Midnight                                                     |
| `tools/`              | Version bump script, mock bundler server, local Midnight devnet helpers                          |

Build order (dependency DAG): `crypto → encryption → payment → storage → chain → core`. The five internal packages are bundled inline into `packages/core`'s output; they are never published standalone.

---

## Development setup

### Prerequisites

- Node.js 22+ and npm (download from [nodejs.org](https://nodejs.org))
- Docker, for the Midnight proof server and Arweave Local (download from [docker.com/get-started](https://www.docker.com/get-started))
- _Only if you modify the contract:_ Midnight [Compact developer tools](https://docs.midnight.network/blog/compact-developer-tools), compiler **version 0.31.1** (the committed ZK artifacts were built with it)
- _For the browser demo's Midnight path:_ [Lace](https://www.lace.io) wallet extension (**version 1.36.2 or later**)
- _For the browser demo's Arweave mainnet path:_ [Wander](https://www.wander.app) wallet extension
- _For anything that talks to Midnight Preprod:_ NIGHT test tokens from the [Midnight Preprod Faucet](https://faucet.preprod.midnight.network/)

### 1. Install dependencies

From the repository root:

```sh
npm install
```

### 2. Build the packages

```sh
npm run build
```

Any time you modify a package (e.g. `packages/crypto` or `packages/chain`), run `npm run build` again before running the demo apps — they consume the compiled package outputs.

The build also produces the browser bundle at `packages/core/dist/browser.mjs` (ESM) and `packages/core/dist/browser.d.mts` (types). It is deliberately **not minified**: minification strips the `/* @vite-ignore */` comments that tell a downstream bundler to skip static analysis of Node-only code paths.

### 3. (Optional) Recompile the `DataRegistry` contract

The `DataRegistry` contract is the on-chain index used by the SDK. It records references to encrypted documents (`refId`, the encrypted `storageId`, key envelope and related metadata) so lookups can resolve a reference to the underlying storage record. It never stores raw user files or plaintext data.

Its compiled output (`packages/chain/src/adapters/midnight/contracts/dataregistry/managed/`, including the ZK prover/verifier keys) is **committed to the repository**, so you only need to recompile if you change `DataRegistry.compact`:

```sh
# Install Compact v0.31.1, matching the committed contract artifacts
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/download/v0.31.1/compact-installer.sh | sh

npm run compile:contract
```

> Changing the contract changes its verifier keys, so it is a breaking change for anyone using an already-deployed `DataRegistry` contract.

### 4. Run the Midnight proof server

Needed for real Midnight writes (console demo, browser demo's Midnight path, full-stack integration tests). See the Midnight [documentation](https://docs.midnight.network/getting-started/installation#run-the-proof-server).

```sh
docker run -p 6300:6300 midnightntwrk/proof-server:8.1.0 -- midnight-proof-server -v
```

### 5. Run Arweave Local

Needed for the console demo, the browser demo's Arweave Local path, and the integration tests:

```sh
docker run -d --rm -p 1984:1984 textury/arlocal

# or:
npx arlocal
```

### Local Midnight devnet (optional)

To test against a fully local Midnight network instead of Preprod, start the `undeployed` stack and fund a wallet:

```sh
docker compose -f tools/compose-undeployed.yml up -d
tools/fund-wallet.sh "<24-word mnemonic>"
```

`tools/fund-wallet.sh --help` describes the options.

---

## Running the demo apps

### Web demo (HealthVault)

```sh
npm run demo:run
```

This builds the packages, copies the ZK artifacts into `apps/demo/public/`, and starts Vite. Open http://localhost:5173 and choose a path:

- upload a new health insurance certificate (a sample is provided at `apps/demo/sakura-certificate.pdf`)
- or jump directly to proof generation from a list of previously uploaded certificates

Copy `apps/demo/.env.example` to `apps/demo/.env` to preconfigure it.

### Console demo

The console demo uses Midnight Preprod and Arweave Local, so it needs the proof server (step 4) and arlocal (step 5) running.

It also needs an Arweave wallet key at `apps/demo-console/test-arweave-wallet-key.json`. This file is gitignored, so generate one first. It's funded automatically by arlocal, so no real AR tokens are needed:

```sh
node -e "
const Arweave = require('arweave');
Arweave.init({}).wallets.generate().then(key => {
  require('fs').writeFileSync('apps/demo-console/test-arweave-wallet-key.json', JSON.stringify(key));
  console.log('Wallet key saved.');
});
"
```

Then run:

```sh
npm run demo-console:run
```

It starts a CLI that:

- asks for a wallet seed/mnemonic and initializes `MidnightChainAdapter`
- provides actions to upload files, list on-chain references, and retrieve content by `refId`

Copy `apps/demo-console/.env.example` to `apps/demo-console/.env` to skip the interactive prompts.

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

## Code conventions

- **TypeScript strict mode**, with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- **ESM**: relative imports use explicit `.js` extensions.
- **Error messages** use the `[dStorage]` or `[dStorage/<component>]` prefix, and thrown errors are `DStorageError`s with a code in the owning package's range (see [Error Handling](README.md#error-handling)).
- **Never log secrets**: no seed bytes, passwords or DEK material, not even at debug level.
- **Privacy by default**: `isPublic: true` must always be an explicit opt-in, never a default.
- **Package boundaries**: storage adapters only ever receive encrypted bytes. Chain adapters never receive seeds or encryption keys. Apps go through `@dstorage/core` instead of re-implementing SDK logic.
- **Tests** live in `packages/*/src/__tests__/*.test.ts` (vitest, globals enabled). Use the in-memory mock adapters, and the minimum scrypt params (`{ N: 32768, r: 8, p: 1 }`) for `PasswordEncryptionAdapter` to keep tests fast.

Before opening a pull request, run:

```sh
npm run check   # prettier + build + unit tests
npm run lint
```

## Submitting changes

1. Fork the repository and create a branch from `main`.
2. Make your change with tests. Update the [README](README.md) if you change public API or behaviour.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (e.g. `feat(chain): ...`, `fix(core): ...`, `docs: ...`). Mark breaking changes with `!` (e.g. `feat(chain)!: ...`).
4. Open a pull request against `main`. CI (`.github/workflows/ci.yml`) runs the build and the unit tests. The integration suite runs weekly and can be triggered manually.

---

## Releasing

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
