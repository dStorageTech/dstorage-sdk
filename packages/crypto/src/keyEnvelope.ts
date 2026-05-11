/**
 * @dstorage/crypto — keyEnvelope.ts
 *
 * Multi-key wrapping for Data Encryption Keys (DEKs).
 *
 * Each private upload generates a fresh random DEK, which is then wrapped
 * (encrypted) under a Key Encryption Key (KEK) derived from the wallet seed.
 * The wrapped DEK and its metadata are serialised as a JSON envelope and
 * stored on-chain in the `keyEnvelope` field of ReferenceEntry.
 *
 * This separates the encryption key (random, unique per upload) from the
 * key-protecting mechanism (wallet-bound), enabling future multi-recipient
 * access without re-encrypting stored data — just add another wrapper entry.
 *
 * Envelope schema (private uploads only — public uploads have no envelope):
 *   {
 *     "v": 1,
 *     "wrappers": [
 *       {
 *         "wrapKeyName": "password",      // identifies the wrapping key source
 *         "algorithm": "xchacha20poly1305-v1",
 *         "kekDerivation": "hkdf-sha256-v1",
 *         "wrappedDek": "<base64url 96 chars>"
 *       }
 *     ]
 *   }
 *
 * The ownerSecret for private uploads is derived deterministically from the wrapped DEK:
 *   ownerSecret = HKDF-SHA256(ikm=DEK, salt=rawStorageId, info="dstorage:owner-secret:v1")
 * Any holder of a valid KEK can unwrap the DEK and re-derive the ownerSecret.
 *
 * `wrappedDek` binary layout (72 bytes):
 *   [ nonce(24) | ciphertext(32) | auth-tag(16) ]
 * base64url-encoded → 96 chars — identical to the on-chain storageId layout.
 */

import { encryptStorageIdXChaCha, decryptStorageIdXChaCha } from "./xchacha.js";
import {
  bytesToBase64url,
  base64urlToBytes,
  type WrappedDekResult,
} from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KeyWrapper extends WrappedDekResult {
  /** Identifies the wrapping key source (e.g. "password", "mnemonic", "mlkem768"). */
  wrapKeyName: string;
}

export interface KeyEnvelope {
  v: 1;
  /**
   * Wrappers for the data DEK (content encryption key). Always present in a valid envelope.
   * The ownerSecret for ownership proofs is derived from the same DEK:
   *   ownerSecret = HKDF-SHA256(DEK, rawStorageId, "dstorage:owner-secret:v1")
   * Any holder of a valid KEK can unwrap the DEK and re-derive the ownerSecret.
   * Public uploads have no envelope (keyEnvelope = "").
   */
  wrappers: [KeyWrapper, ...KeyWrapper[]];
}

// ── DEK generation ────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random 32-byte Data Encryption Key.
 * Uses the platform CSPRNG (`crypto.getRandomValues`) — safe in both
 * browser and Node.js 19+.
 */
export function generateDek(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

// ── KEK derivation ────────────────────────────────────────────────────────────

/**
 * Derive a 32-byte Key Encryption Key from seed bytes using HKDF-SHA-256.
 *
 * Uses the same salt as the data encryption key ("dstorage-xchacha-v1") but a
 * distinct info string ("dstorage:xchacha20poly1305:kek:v1") to domain-separate
 * the KEK from all other keys derived from the same seed.
 *
 * @param seed     High-entropy seed bytes (wallet signature, BIP-39 seed, etc.)
 * @param context  Optional wallet address or other binding context, incorporated
 *                 into the info string to bind the KEK to a specific account.
 */
export async function deriveKek(
  seed: Uint8Array,
  context?: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    new Uint8Array(seed),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const info = context
    ? `dstorage:xchacha20poly1305:kek:v1:${context}`
    : "dstorage:xchacha20poly1305:kek:v1";
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("dstorage-xchacha-v1"),
      info: enc.encode(info),
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

// ── DEK wrapping / unwrapping ─────────────────────────────────────────────────

/**
 * Wrap (encrypt) a 32-byte DEK under a KEK using XChaCha20-Poly1305.
 *
 * Reuses the same 72-byte binary layout as on-chain storageId encryption:
 *   [ nonce(24) | ciphertext(32) | auth-tag(16) ]
 * base64url-encoded → 96-char string.
 *
 * @param dek  32-byte Data Encryption Key to protect
 * @param kek  32-byte Key Encryption Key (from deriveKek())
 */
export async function wrapKey(
  dek: Uint8Array,
  kek: Uint8Array,
): Promise<string> {
  if (dek.length !== 32) {
    throw new Error(
      `[dStorage] wrapKey: DEK must be 32 bytes, got ${dek.length}`,
    );
  }
  const wrapped = await encryptStorageIdXChaCha(kek, dek);
  return bytesToBase64url(wrapped);
}

/**
 * Unwrap (decrypt) a wrapped DEK string back to the original 32-byte DEK.
 *
 * @param wrappedDek  base64url-encoded 96-char string from wrapKey()
 * @param kek         32-byte Key Encryption Key (from deriveKek())
 */
export async function unwrapKey(
  wrappedDek: string,
  kek: Uint8Array,
): Promise<Uint8Array> {
  const wrapped = base64urlToBytes(wrappedDek);
  return decryptStorageIdXChaCha(kek, wrapped);
}

// ── Owner secret derivation ───────────────────────────────────────────────────

/** Domain separator for owner secret derivation. Must never be reused for any other key. */
const OWNER_SECRET_DOMAIN = "dstorage:owner-secret:v1";

/**
 * Derive a 32-byte owner secret from the data DEK and the raw storage ID.
 *
 * Derivation: HKDF-SHA-256(ikm=dek, salt=rawStorageId, info=OWNER_SECRET_DOMAIN)
 *
 * Security properties:
 *   - Post-quantum resistant: HKDF-SHA-256 is purely symmetric (no elliptic-curve math).
 *   - One-way: the DEK cannot be recovered from the ownerSecret (HKDF preimage resistance).
 *   - Key-separated: the ownerSecret cannot be used for data encryption.
 *   - Per-upload unique: different DEK + storageId per upload → different ownerSecret.
 *   - Derivable: any holder of a valid KEK can unwrap the DEK and re-derive the ownerSecret.
 *
 * @param ikm           32-byte key material (DEK for private uploads; KEK for public uploads)
 * @param rawStorageId  Raw storage network ID bytes (e.g. Arweave txId encoded as UTF-8)
 * @param info          HKDF info / domain separator (defaults to private-upload domain)
 */
export async function deriveOwnerSecret(
  ikm: Uint8Array,
  rawStorageId: Uint8Array,
  info: string = OWNER_SECRET_DOMAIN,
): Promise<Uint8Array> {
  // Uint8Array.from() produces Uint8Array<ArrayBuffer> which is required by WebCrypto.
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    Uint8Array.from(ikm),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Uint8Array.from(rawStorageId),
      info: new TextEncoder().encode(info),
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

// ── Envelope helpers ──────────────────────────────────────────────────────────

/**
 * Build a v1 key envelope wrapping the data DEK under one or more KEKs.
 *
 * Each entry wraps the same random DEK under a different KEK (one per seed
 * provider), allowing any of the corresponding recipients to independently
 * decrypt the same content without re-encryption.
 *
 * The ownerSecret for ownership proofs is derived from the same DEK:
 *   ownerSecret = HKDF-SHA256(DEK, rawStorageId, "dstorage:owner-secret:v1")
 * No separate ownership key is needed.
 *
 * @param wrappers  Non-empty array of `{ wrappedDek, wrapKeyName }` pairs.
 *                  `wrappedDek` is the base64url-encoded output of wrapKey().
 *                  `wrapKeyName` is a caller-chosen label (e.g. "provider-0").
 *
 * @throws if `wrappers` is empty.
 */
export function buildKeyEnvelope(wrappers: Array<KeyWrapper>): KeyEnvelope {
  if (wrappers.length === 0) {
    throw new Error(
      "[dStorage/crypto] buildKeyEnvelope: at least one wrapper is required.",
    );
  }
  return {
    v: 1,
    wrappers: wrappers as [KeyWrapper, ...KeyWrapper[]],
  };
}

/**
 * Serialise a KeyEnvelope to the JSON string stored on-chain.
 */
export function serializeKeyEnvelope(envelope: KeyEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parse and validate a JSON string from the chain.
 * Returns null for empty strings or malformed / unrecognised envelopes.
 */
export function parseKeyEnvelope(raw: string): KeyEnvelope | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as any).v !== 1 ||
      !Array.isArray((parsed as any).wrappers) ||
      (parsed as any).wrappers.length === 0
    ) {
      return null;
    }
    return parsed as KeyEnvelope;
  } catch {
    return null;
  }
}

/**
 * Find a wrapper by its wrapKeyName. Returns null if not found.
 */
export function findWrapper(
  envelope: KeyEnvelope,
  wrapKeyName: string,
): KeyWrapper | null {
  return envelope.wrappers.find((w) => w.wrapKeyName === wrapKeyName) ?? null;
}
