# dStorage SDK

> Privacy-first data layer for dApps — client-side encryption + decentralised storage + on-chain coordination in a single SDK.

For teams building privacy-sensitive dApps (health, identity, finance, and enterprise workflows) that need strong client-side confidentiality without operating plaintext data infrastructure.

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

For developers, the SDK is designed to get out of the way. You configure it once with the storage and chain backends that fit your stack, call `init()`, and use `upload` and `retrieveByRefId`. You can start entirely with in-memory mocks (no network, no tokens, no wallet extension), and swap in network-backed adapters when you are ready.

---

## SDK Usage

```sh
npm install @dstorage-tech/dstorage
```

```typescript
import {
  DStorage,
  MockStorageAdapter,
  MockChainAdapter,
  PasswordEncryptionAdapter,
} from "@dstorage-tech/dstorage";

// 1. Configure the SDK with your chosen adapters and encryption adapter(s)
const sdk = new DStorage({
  storageAdapter: new MockStorageAdapter(), // swap for ArweaveStorageAdapter, ArweaveLocalStorageAdapter, etc.
  chainAdapter: new MockChainAdapter(), // swap for MidnightChainAdapter
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
const { bytes } = await sdk.retrieveByRefId(chainRefId);
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

### Arweave Local (development)

[arlocal](https://github.com/textury/arlocal) is a local Arweave node for development and testing. `ArweaveLocalStorageAdapter` targets it by default (`localhost:1984`).

**Path A — auto-generated test wallet** (recommended for local dev and tests):

```typescript
import { ArweaveLocalStorageAdapter } from "@dstorage-tech/dstorage";

// Spins up a funded wallet against the running arlocal instance
const storageAdapter = await ArweaveLocalStorageAdapter.createWithTestWallet({
  fundAr: 10, // AR tokens to mint (default: 10)
});
```

**Path B — existing wallet key file** (e.g. a pre-funded JWK on disk):

```typescript
import fs from "node:fs";
import { ArweaveLocalStorageAdapter } from "@dstorage-tech/dstorage";

const walletKey = JSON.parse(fs.readFileSync("arweave-wallet.json", "utf8"));
const storageAdapter = new ArweaveLocalStorageAdapter({ walletKey });
```

**Path C — custom gateway host and port** (e.g. arlocal running on a different machine or port):

```typescript
import { ArweaveLocalStorageAdapter } from "@dstorage-tech/dstorage";

const storageAdapter = new ArweaveLocalStorageAdapter({
  gateway: { host: "192.168.1.42", port: 4000, protocol: "http" },
});
```

---

## Error Handling

Every error thrown by the SDK is a `DStorageError` — a subclass of `Error` that always carries a numeric `.code`. Use the `isDStorageError` type guard to distinguish SDK errors from unexpected runtime failures:

```typescript
import { isDStorageError } from "@dstorage-tech/dstorage";

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
import { isStorePartialError } from "@dstorage-tech/dstorage";

try {
  await sdk.store(bytes);
} catch (err) {
  if (isStorePartialError(err)) {
    const { storageId, storageProvider, keyEnvelope } = err.recovery;
    const { chainRefId } = await sdk.registerReference(storageId, {
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
- `init()` is not required; no wallet or encryption key is needed.
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

| Adapter                     | Seed source                                                        | Post-quantum safety                                                                                                                                                     | Cross-device portability                                                                                            |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PasswordEncryptionAdapter` | scrypt(password, caller-supplied salt)                             | ⚠️ 128-bit PQ at the data layer (NIST minimum). Key encapsulation safety depends on password entropy — use `generatePqsPassword()` for machine-generated PQ-safe input. | ✅ Same seed on any device — depends only on password + salt                                                        |
| `MnemonicEncryptionAdapter` | BIP-39 mnemonic phrase (**24 words required**) or 64-byte hex seed | ✅ 128-bit PQ — unconditional (CSPRNG-generated 256-bit entropy; Grover's halves to 128-bit). Fewer than 24 words is rejected at construction.                          | ✅ Same seed wherever the same mnemonic/hex is imported                                                             |
| `KeypairEncryptionAdapter`  | ML-KEM public/secret key pair (NIST FIPS 203 — post-quantum)       | ✅ 192-bit PQ via ML-KEM768 — unconditional, no password or entropy requirement.                                                                                        | ⚠️ Requires the Secret Key for decryption — not re-derivable unless created via `fromPassword()` / `fromMnemonic()` |

#### Cross-device portability

| Scenario                                                                              | Expected outcome                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Same password + same salt on a different device (`PasswordEncryptionAdapter`)         | ✅ Same seed — scrypt output depends only on password, salt, and KDF params; no wallet required.              |
| BIP-39 mnemonic imported on a different machine (`MnemonicEncryptionAdapter`)         | ✅ Same seed — the mnemonic is the only input; derivation is purely deterministic.                            |
| Different password, same salt (`PasswordEncryptionAdapter`)                           | ❌ Different seed — intentional; each password produces an independent key.                                   |
| ML-KEM keypair from `generateKeypair()` re-imported (`KeypairEncryptionAdapter`)      | ✅ Same keypair wherever the SK bytes are imported — but the SK must be stored; it cannot be re-derived.      |
| ML-KEM keypair from `fromPassword()` or `fromMnemonic()` (`KeypairEncryptionAdapter`) | ✅ Same keypair — deterministic; no key storage needed, re-derive from password+salt or mnemonic at any time. |
| `KeypairEncryptionAdapter.fromPublicKey(pk)` (upload-only)                            | 🔒 PK-only — can wrap DEK for upload; unwrapping requires the matching SK.                                    |

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
  KeypairEncryptionAdapter.generateKeypair();
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
// 1 — Fresh random keypair (store the SK):
const { adapter, publicKey, secretKey } =
  KeypairEncryptionAdapter.generateKeypair();

// 2 — PK-only uploader (no SK needed at upload time):
const uploader = KeypairEncryptionAdapter.fromPublicKey(publicKey);

// 3 — Full keypair reader:
const reader = KeypairEncryptionAdapter.fromKeypair(publicKey, secretKey);

// 4 — Deterministic keypair from password (same inputs → same keypair, always):
const adapter = await KeypairEncryptionAdapter.fromPassword(password, salt);

// 5 — Deterministic keypair from BIP-39 mnemonic:
const adapter = await KeypairEncryptionAdapter.fromMnemonic({ mnemonic });
```

#### Post-quantum safety across all adapters

Every private upload has two independently protected layers:

| Layer                 | Primitive                       | PQ security (all adapters)                                                                                         |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Data payload**      | XChaCha20-Poly1305, 256-bit key | ✅ 128-bit PQ — Grover's algorithm halves effective key length; NIST SP 800-131A approves 128-bit PQ as sufficient |
| **Key encapsulation** | Adapter-dependent               | Varies — see table below                                                                                           |

The **key encapsulation layer** is where adapters differ:

| Adapter                     | Key encapsulation mechanism                 | PQ safety                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PasswordEncryptionAdapter` | scrypt(password) → HKDF-SHA-256 → KEK       | ⚠️ Conditional on password entropy. A quantum attacker can brute-force the password; human-chosen passwords cannot reach the 256-bit entropy required for PQ-safe key encapsulation. Use `generatePqsPassword()` for machine-generated input. |
| `MnemonicEncryptionAdapter` | BIP-39(mnemonic) → HKDF-SHA-256 → KEK       | ✅ 128-bit PQ — a 24-word BIP-39 mnemonic is CSPRNG-generated (256 bits of entropy); Grover's halves this to 128-bit. Unconditional and enforced: the adapter rejects mnemonics shorter than 24 words at construction time.                   |
| `KeypairEncryptionAdapter`  | ML-KEM encapsulate(PK) → HKDF-SHA-256 → KEK | ✅ 192-bit PQ — security rests on the LWE problem; no known quantum speedup exists. Highest level available.                                                                                                                                  |

For **"harvest now, decrypt later"** threat models, both `MnemonicEncryptionAdapter` (128-bit PQ, unconditional) and `KeypairEncryptionAdapter` (192-bit PQ, unconditional) provide solid post-quantum guarantees at the key encapsulation level. `PasswordEncryptionAdapter` with a human-chosen password does not — use `generatePqsPassword()` to close that gap.

#### Machine-generated PQ-safe passwords

If you want cross-device password recoverability **and** full ML-KEM post-quantum security, use `generatePqsPassword()`:

```typescript
import {
  generatePqsPassword,
  KeypairEncryptionAdapter,
} from "@dstorage/encryption";

// 32 random bytes → 43-char base64url string (256 bits of real entropy).
// Store this string — it is the only secret needed to re-derive the keypair on any device.
const password = generatePqsPassword();

// Derives an ML-KEM keypair via scrypt → 64-byte seed → ML-KEM keygen.
// Same password + salt → same keypair, always, on any device.
const adapter = await KeypairEncryptionAdapter.fromPassword(
  password,
  "myapp:alice",
);
```

> **Warning — human-chosen passwords are not PQ-safe at the key encapsulation layer.**
> No human-memorable password or passphrase can reach the 256-bit entropy required to
> resist a Grover's-algorithm brute-force. Human passwords still provide 128-bit PQ
> security at the _data_ layer (NIST minimum, sufficient for most applications) but a
> quantum attacker could recover the password and rederive the KEK. Use
> `generatePqsPassword()` with `KeypairEncryptionAdapter.fromPassword()`, or
> `MnemonicEncryptionAdapter` with a 24-word BIP-39 mnemonic (12-word mnemonics are
> rejected — they give only 64-bit PQ security), if key-encapsulation-level PQ safety
> is required.

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

**XChaCha20-Poly1305** (72 bytes, base64url-encoded → 96 chars):

```
[ nonce: 24 bytes | ciphertext: 32 bytes | Poly1305 tag: 16 bytes ]
```

### Scheme detection on read

| `encryptionScheme` value | Behaviour                                                                         |
| ------------------------ | --------------------------------------------------------------------------------- |
| `"xchacha20poly1305-v1"` | Unwrap DEK from `keyEnvelope`, decrypt with XChaCha20-Poly1305                    |
| `""` or absent           | No decryption — content is public (see [Public mode](#public-mode-ispublic-true)) |

### Tamper detection

**Authenticated Encryption with Associated Data (AEAD)**. The Poly1305 tag covers the ciphertext. Any bit-flip in the on-chain encrypted pointer causes decryption to throw before the SDK ever attempts to fetch from storage.

### Storage ID format

All storage IDs are 43-character base64url strings — 32 random bytes encoded without padding. This matches the Arweave transaction ID format and guarantees a fixed-width 32-byte plaintext input for the storageId encryption functions.

### Key loss and data recovery

Encryption keys are derived deterministically from the encryption adapter's inputs — no key material is stored by the SDK. This means:

- **The same inputs always produce the same key**: reconnecting with the same adapter and credentials decrypts existing data transparently.
- **Losing your credentials means permanent data loss.** There is no key escrow, no recovery mechanism, and no way to decrypt data without the original inputs:
  - `PasswordEncryptionAdapter` — forgetting the password or losing the salt string makes data unrecoverable.
  - `MnemonicEncryptionAdapter` / wallet providers — losing the seed phrase or private key has the same effect. Follow standard seed-phrase backup practices.
  - `KeypairEncryptionAdapter` — if created with `generateKeypair()`, losing the SK bytes makes data unrecoverable. If created deterministically via `fromPassword()` or `fromMnemonic()`, the keypair can be re-derived from the original inputs.
