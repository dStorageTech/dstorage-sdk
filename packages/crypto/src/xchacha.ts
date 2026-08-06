/**
 * @dstorage/crypto — xchacha.ts
 * Symmetric authenticated encryption using XChaCha20-Poly1305.
 *
 * Key derivation:
 *   seed bytes (from EncryptionAdapter)
 *     → HKDF-SHA-256 (domain-separated, optionally address-bound)
 *     → 32-byte symmetric key (KEK)
 *     → per-upload random DEK wrapped under KEK
 *
 * Why XChaCha20-Poly1305:
 *   - 192-bit nonce eliminates birthday-bound collision risk —
 *     safe to generate random nonces indefinitely
 *   - Pure bytes in / bytes out — no WebCrypto CryptoKey ceremony
 *   - Better performance on hardware without AES acceleration (mobile, ARM, IoT)
 *
 * Why a single symmetric key instead of a KEM keypair:
 *   A KEM step would only add value if data needed to be
 *   encrypted for a different recipient using their public key. For single-user
 *   self-encryption where the same party encrypts and decrypts, HKDF → XChaCha20
 *   is simpler, has much smaller ciphertext overhead, and provides equivalent
 *   security. If cross-user encryption is required in the future the scheme
 *   can be extended with a KEM layer at that point.
 *
 * On-chain storageId format (JSON):
 *   Same envelope as off-chain payloads — handles arbitrary-length string IDs.
 *   { ciphertext: base64, nonce: base64, algorithm: "XChaCha20-Poly1305" }
 *
 * Off-chain payload format (JSON):
 *   { ciphertext: base64, nonce: base64, algorithm: "XChaCha20-Poly1305" }
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { CryptoScheme } from "./types.js";
import { DStorageError, CryptoErrorCode } from "./errors.js";
import { getCrypto } from "./webcrypto.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Encrypted payload stored off-chain (Arweave, etc.). All binary fields are base64. */
export interface XChaChaPayload {
  /** base64 — XChaCha20-Poly1305 output: ciphertext || 16-byte Poly1305 tag */
  ciphertext: string;
  /** base64 — 24-byte random nonce */
  nonce: string;
  /** Algorithm identifier */
  algorithm: "XChaCha20-Poly1305";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binaryStr = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize);
    binaryStr += String.fromCharCode(...chunk);
  }
  return btoa(binaryStr);
}

function base64ToBytes(b64: string): Uint8Array {
  const str = atob(b64);
  const result = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) result[i] = str.charCodeAt(i);
  return result;
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive a 32-byte symmetric key for XChaCha20-Poly1305 from arbitrary seed bytes.
 *
 * Uses HKDF-SHA-256 with a fixed global salt (domain separator) and a versioned,
 * context-bound `info` string per RFC 5869:
 *   - `salt`  = fixed application-level extraction key ("dstorage-xchacha-v1")
 *   - `info`  = versioned label, optionally binding a wallet address
 *
 * @param seed     High-entropy seed bytes (wallet signature, BIP-39 seed, hex seed, etc.)
 * @param context  Optional wallet address or other per-context binding value.
 *                 Incorporated into `info` to bind the derived key to a specific account.
 */
export async function deriveSymmetricKeyFromSeed(
  seed: Uint8Array,
  context?: string,
): Promise<Uint8Array> {
  const crypto = getCrypto();
  const enc = new TextEncoder();
  // new Uint8Array(seed) ensures a plain ArrayBuffer — required by WebCrypto importKey
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(seed),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const info = context
    ? `dstorage:xchacha20poly1305:v1:${context}`
    : "dstorage:xchacha20poly1305:v1";
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("dstorage-xchacha-v1"), // fixed global domain separator
      info: enc.encode(info), // versioned + optionally context-bound
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

// ── AAD ───────────────────────────────────────────────────────────────────────

/** Internal AAD for on-chain storageId encryption — not exposed to callers. */
const STORAGE_ID_AAD: Uint8Array = new TextEncoder().encode(
  "dstorage:storageId:v1",
);

// ── Core encryption / decryption ──────────────────────────────────────────────

/**
 * Encrypt arbitrary bytes with XChaCha20-Poly1305.
 *
 * Non-deterministic: fresh random 24-byte nonce per call.
 *
 * @param key   32-byte symmetric key from deriveSymmetricKeyFromSeed()
 * @param data  Arbitrary plaintext bytes
 * @param aad   Additional authenticated data bound to the ciphertext (recommended)
 */
export async function encryptXChaCha(
  key: Uint8Array,
  data: Uint8Array,
  aad?: Uint8Array,
): Promise<XChaChaPayload> {
  const nonce = getCrypto().getRandomValues(new Uint8Array(24));
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(data);
  return {
    ciphertext: bufferToBase64(ciphertext),
    nonce: bufferToBase64(nonce),
    algorithm: "XChaCha20-Poly1305",
  };
}

/**
 * Decrypt a payload produced by encryptXChaCha().
 * The `aad` must match exactly what was passed to encryptXChaCha() — the Poly1305
 * auth tag covers the AAD, so any mismatch causes decryption to throw.
 *
 * @param key      32-byte symmetric key (must match the key used to encrypt)
 * @param payload  XChaChaPayload from encryptXChaCha()
 * @param aad      Must match the AAD used during encryption
 * @throws If Poly1305 auth tag verification fails (wrong key, tampered data, or wrong AAD)
 */
export async function decryptXChaCha(
  key: Uint8Array,
  payload: XChaChaPayload,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const nonce = base64ToBytes(payload.nonce);
  const ciphertext = base64ToBytes(payload.ciphertext);
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new DStorageError(
      CryptoErrorCode.XCHACHA_PAYLOAD_MALFORMED,
      "[dStorage/crypto] XChaCha: authentication tag verification failed.",
    );
  }
}

// ── On-chain storageId encryption ─────────────────────────────────────────────
//
// Fixed 72-byte binary layout for on-chain Compact contract:
//   [ nonce(24) | ciphertext(32) | auth-tag(16) ]
//
// XChaCha20-Poly1305 appends the 16-byte Poly1305 tag to the output,
// so a 32-byte storageId produces 48 bytes (ct + tag) which are split here.
// Base64url-encoded this is 96 chars — a significant improvement over the
// previous 1547-char layout.

const XCHACHA_STORAGE_ID_BYTES = 72; // 24 + 32 + 16

/**
 * Encrypt a 32-byte storage ID for on-chain storage.
 *
 * Output is exactly 72 bytes: [ nonce(24) | ciphertext(32) | auth-tag(16) ].
 *
 * @param key             32-byte symmetric key from deriveSymmetricKeyFromSeed()
 * @param storageIdBytes  Raw 32-byte storage ID
 */
export async function encryptStorageIdXChaCha(
  key: Uint8Array,
  storageIdBytes: Uint8Array,
): Promise<Uint8Array> {
  const nonce = getCrypto().getRandomValues(new Uint8Array(24));
  const encrypted = xchacha20poly1305(key, nonce, STORAGE_ID_AAD).encrypt(
    storageIdBytes,
  );
  // xchacha20poly1305 appends the 16-byte Poly1305 tag to the output
  const ct = encrypted.slice(0, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);

  const result = new Uint8Array(XCHACHA_STORAGE_ID_BYTES);
  result.set(nonce, 0); //  0..23  nonce
  result.set(ct, 24); // 24..55  ciphertext (32 bytes for a 32-byte input)
  result.set(tag, 56); // 56..71  Poly1305 auth tag
  return result;
}

/**
 * Decrypt a storage ID previously encrypted with encryptStorageIdXChaCha().
 * Expects exactly 72 bytes.
 * Throws if the Poly1305 auth tag does not match (tamper-evident).
 *
 * @param key             32-byte symmetric key (must match encryption key)
 * @param encryptedBytes  72-byte on-chain payload
 */
export async function decryptStorageIdXChaCha(
  key: Uint8Array,
  encryptedBytes: Uint8Array,
): Promise<Uint8Array> {
  if (encryptedBytes.length !== XCHACHA_STORAGE_ID_BYTES) {
    throw new DStorageError(
      CryptoErrorCode.XCHACHA_INVALID_STORAGE_ID_LEN,
      `[dStorage/crypto] XChaCha storageId must be ${XCHACHA_STORAGE_ID_BYTES} bytes, got ${encryptedBytes.length}`,
    );
  }
  const nonce = encryptedBytes.slice(0, 24);
  const ct = encryptedBytes.slice(24, 56);
  const tag = encryptedBytes.slice(56, 72);

  // xchacha20poly1305 expects [ciphertext || tag]
  const ctWithTag = new Uint8Array(ct.length + tag.length);
  ctWithTag.set(ct, 0);
  ctWithTag.set(tag, ct.length);
  try {
    return xchacha20poly1305(key, nonce, STORAGE_ID_AAD).decrypt(ctWithTag);
  } catch {
    throw new DStorageError(
      CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
      "[dStorage/crypto] XChaCha: storageId authentication tag verification failed.",
    );
  }
}

// ── Serialisation helpers ─────────────────────────────────────────────────────

/**
 * Serialize an XChaChaPayload to a compact JSON string.
 * Safe to pass to off-chain storage APIs.
 */
export function serializeXChaChaPayload(payload: XChaChaPayload): string {
  return JSON.stringify(payload);
}

/**
 * Deserialize a JSON string back to an XChaChaPayload.
 * Returns null if the input is invalid or missing required fields.
 */
export function deserializeXChaChaPayload(raw: string): XChaChaPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("ciphertext" in parsed) ||
      !("nonce" in parsed) ||
      !("algorithm" in parsed)
    ) {
      return null;
    }
    return parsed as XChaChaPayload;
  } catch {
    return null;
  }
}

// ── XChaChaScheme ─────────────────────────────────────────────────────────────

/** XChaCha20-Poly1305 scheme. Key derived via HKDF-SHA-256. */
export class XChaChaScheme implements CryptoScheme {
  readonly schemeName = "xchacha20poly1305-v1" as const;
  private readonly key: Uint8Array;

  private constructor(key: Uint8Array) {
    this.key = key;
  }

  /**
   * Derive a 32-byte XChaCha20-Poly1305 key from seed bytes using HKDF-SHA-256.
   *
   * @param seed     High-entropy seed bytes (wallet signature, BIP-39 seed, etc.)
   * @param context  Optional wallet address or other binding context.
   *                 Incorporated into the HKDF salt to bind the key to a specific account.
   */
  static async create(
    seed: Uint8Array,
    context?: string,
  ): Promise<XChaChaScheme> {
    const key = await deriveSymmetricKeyFromSeed(seed, context);
    return new XChaChaScheme(key);
  }

  /**
   * Create a scheme instance from a pre-generated key (e.g. a random DEK).
   * Bypasses HKDF derivation — use when the key is already available.
   *
   * @param key  32-byte symmetric key
   */
  static fromKey(key: Uint8Array): XChaChaScheme {
    return new XChaChaScheme(key);
  }

  async encryptPayload(
    bytes: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array> {
    const payload = await encryptXChaCha(this.key, bytes, aad);
    return new TextEncoder().encode(serializeXChaChaPayload(payload));
  }

  async decryptPayload(data: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const payload = deserializeXChaChaPayload(new TextDecoder().decode(data));
    if (!payload) {
      throw new DStorageError(
        CryptoErrorCode.XCHACHA_PAYLOAD_MALFORMED,
        "[dStorage/crypto] XChaCha: payload is missing required fields.",
      );
    }
    return decryptXChaCha(this.key, payload, aad);
  }

  async encryptStorageId(storageId: string): Promise<string> {
    const bytes = new TextEncoder().encode(storageId);
    const payload = await encryptXChaCha(this.key, bytes, STORAGE_ID_AAD);
    return serializeXChaChaPayload(payload);
  }

  async decryptStorageId(encryptedId: string): Promise<string> {
    const payload = deserializeXChaChaPayload(encryptedId);
    if (!payload) {
      throw new DStorageError(
        CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
        "[dStorage/crypto] XChaCha: storageId payload is malformed.",
      );
    }
    const decrypted = await decryptXChaCha(this.key, payload, STORAGE_ID_AAD);
    return new TextDecoder().decode(decrypted);
  }
}
