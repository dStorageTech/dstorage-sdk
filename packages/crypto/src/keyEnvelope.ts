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
 * Envelope schema:
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
 * `wrappedDek` binary layout (72 bytes):
 *   [ nonce(24) | ciphertext(32) | auth-tag(16) ]
 * base64url-encoded → 96 chars — identical to the on-chain storageId layout.
 */

import { encryptStorageIdXChaCha, decryptStorageIdXChaCha } from "./xchacha.js";
import { bytesToBase64url, base64urlToBytes } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KeyWrapper {
  /** Index identifying the wrapping key source (e.g. "password", "biometric", "recipient:addr"). */
  wrapKeyName: string;
  /** Cipher used to wrap the DEK. */
  algorithm: "xchacha20poly1305-v1";
  /** How the KEK was derived from its source material. */
  kekDerivation: "hkdf-sha256-v1";
  /** base64url-encoded 72-byte wrapped DEK: [nonce(24)|ciphertext(32)|mac(16)]. */
  wrappedDek: string;
}

export interface KeyEnvelope {
  v: 1;
  /** At least one wrapper must be present. */
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

// ── Envelope helpers ──────────────────────────────────────────────────────────

/**
 * Build a v1 key envelope containing a single seed-derived wrapper.
 *
 * @param wrappedDek   base64url-encoded wrapped DEK from wrapKey()
 * @param wrapKeyName  Identifier for this wrapper. Defaults to "password".
 */
export function buildKeyEnvelope(
  wrappedDek: string,
  wrapKeyName = "password",
): KeyEnvelope {
  return {
    v: 1,
    wrappers: [
      {
        wrapKeyName,
        algorithm: "xchacha20poly1305-v1",
        kekDerivation: "hkdf-sha256-v1",
        wrappedDek,
      },
    ],
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

/**
 * Return a new envelope with an additional wrapper appended.
 * Use this to add a second (or Nth) recipient KEK to an existing envelope
 * without re-encrypting the stored data.
 *
 * @param envelope    Existing KeyEnvelope to extend
 * @param wrappedDek  base64url-encoded wrapped DEK from wrapKey() for the new recipient
 * @param wrapKeyName Identifier for this wrapper (e.g. "mnemonic", "additional-0")
 */
export function addWrapper(
  envelope: KeyEnvelope,
  wrappedDek: string,
  wrapKeyName: string,
): KeyEnvelope {
  return {
    ...envelope,
    wrappers: [
      ...envelope.wrappers,
      {
        wrapKeyName,
        algorithm: "xchacha20poly1305-v1",
        kekDerivation: "hkdf-sha256-v1",
        wrappedDek,
      },
    ],
  };
}
