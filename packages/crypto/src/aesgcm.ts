/**
 * @dstorage/crypto — aesgcm.ts
 * AES-256-GCM encryption/decryption using the WebCrypto API.
 * Works in both browser (native) and Node.js 18+ (globalThis.crypto).
 *
 * Supported for backward-compatible decryption of older on-chain records.
 * New writes use XChaChaScheme (xchacha.ts) by default.
 */

import type { CryptoScheme } from "./types.js";
import { base64urlToBytes, bytesToBase64url } from "./types.js";
import { deriveKeyFromSignature } from "./keys.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Shape of an AES-GCM encrypted payload stored alongside its IV. */
export interface EncryptedPayload {
  /** AES-GCM ciphertext as base64 string */
  ciphertext: string;
  /** 12-byte initialisation vector as base64 string */
  iv: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCrypto(): Crypto {
  if (typeof globalThis.crypto !== "undefined") return globalThis.crypto;
  throw new Error(
    "[dStorage/crypto] WebCrypto not available in this environment.",
  );
}

function bufferToBase64(buffer: ArrayBuffer): string {
  // Convert buffer to string in chunks to avoid "Maximum call stack size exceeded"
  // with large files. String.fromCharCode can only handle ~64KB arguments at a time.
  const bytes = new Uint8Array(buffer);
  let binaryStr = "";
  const chunkSize = 8192; // Process 8KB at a time

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize);
    binaryStr += String.fromCharCode(...chunk);
  }

  return btoa(binaryStr);
}

function base64ToBuffer(b64: string): Uint8Array<ArrayBuffer> {
  const str = atob(b64);
  const result = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) result[i] = str.charCodeAt(i);
  return result;
}

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * Encrypt arbitrary bytes using AES-GCM 256.
 * Returns a self-contained EncryptedPayload (ciphertext + iv) ready to store.
 */
export async function encrypt(
  key: CryptoKey,
  data: Uint8Array,
): Promise<EncryptedPayload> {
  const crypto = getCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new Uint8Array(data),
  );

  return {
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv.buffer as ArrayBuffer),
  };
}

/**
 * Decrypt an EncryptedPayload back to its original bytes.
 */
export async function decrypt(
  key: CryptoKey,
  payload: EncryptedPayload,
): Promise<Uint8Array> {
  const crypto = getCrypto();

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBuffer(payload.iv) },
    key,
    base64ToBuffer(payload.ciphertext),
  );

  return new Uint8Array(plaintext);
}

/**
 * Serialize an EncryptedPayload to a compact JSON string safe to pass to storage.
 */
export function serializePayload(payload: EncryptedPayload): string {
  return JSON.stringify(payload);
}

/**
 * Deserialize a stored JSON string back to an EncryptedPayload.
 */
export function deserializePayload(raw: string): EncryptedPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("ciphertext" in parsed) ||
      !("iv" in parsed)
    ) {
      throw new Error("[dStorage/crypto] Invalid payload format.");
    }
    return parsed as EncryptedPayload;
  } catch {
    return null;
  }
}

// ── StorageId encryption (AES-GCM, authenticated) ────────────────────────────
//
// Uses AES-GCM (AEAD) so the encrypted storageId is tamper-evident:
// any bit-flip is detected during decryption via the authentication tag.
//
// Binary payload layout (60 bytes):
//   [ ciphertext: 32 bytes | IV: 12 bytes | auth tag: 16 bytes ]
//
// This 60-byte payload is base64url-encoded (80 chars) before being stored
// on-chain as an Opaque<"string"> in the DataRegistry contract.

/**
 * Encrypt a 32-byte storage ID using AES-GCM.
 * Output is exactly 60 bytes: [ciphertext(32) | IV(12) | tag(16)].
 */
export async function encryptStorageId(
  key: CryptoKey,
  storageIdBytes: Uint8Array,
): Promise<Uint8Array> {
  const crypto = getCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // AES-GCM output for 32-byte input: [ciphertext(32) | tag(16)] = 48 bytes
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    storageIdBytes.buffer as ArrayBuffer,
  );
  const encryptedBytes = new Uint8Array(encrypted);

  // Pack into 60-byte layout: [ciphertext(32) | IV(12) | tag(16)]
  const result = new Uint8Array(60);
  result.set(encryptedBytes.slice(0, 32), 0); // ciphertext
  result.set(iv, 32); // IV
  result.set(encryptedBytes.slice(32), 44); // auth tag
  return result;
}

/**
 * Decrypt a storage ID previously encrypted with encryptStorageId().
 * Expects exactly 60 bytes: [ciphertext(32) | IV(12) | tag(16)].
 * Throws if the auth tag does not match (tamper detection).
 */
export async function decryptStorageId(
  key: CryptoKey,
  encryptedBytes: Uint8Array,
): Promise<Uint8Array> {
  const crypto = getCrypto();

  // Unpack 60-byte layout
  const ciphertext = encryptedBytes.slice(0, 32);
  const iv = encryptedBytes.slice(32, 44);
  const tag = encryptedBytes.slice(44, 60);

  // WebCrypto AES-GCM expects [ciphertext | tag]
  const ciphertextWithTag = new Uint8Array(48);
  ciphertextWithTag.set(ciphertext, 0);
  ciphertextWithTag.set(tag, 32);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertextWithTag.buffer as ArrayBuffer,
  );
  return new Uint8Array(decrypted);
}

// ── AesGcmScheme ──────────────────────────────────────────────────────────────

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * AES-256-GCM scheme. Keys derived via PBKDF2 (100k iterations).
 * Supported for backward-compatible decryption of older on-chain records.
 * New writes use XChaChaScheme by default.
 */
export class AesGcmScheme implements CryptoScheme {
  readonly schemeName = "aes-gcm-v1" as const;
  private readonly encKey: CryptoKey;

  private constructor(encKey: CryptoKey) {
    this.encKey = encKey;
  }

  /**
   * Derive an AES-GCM key from seed bytes using PBKDF2.
   * The same key is used for both content and storageId encryption.
   *
   * Uses `context` (wallet address) as the PBKDF2 salt.
   * Falls back to a default salt when context is absent (e.g. facade/init() mode).
   *
   * @param seed     High-entropy seed bytes (wallet signature, BIP-39 seed, etc.)
   * @param context  Wallet address — used as PBKDF2 salt.
   */
  static async create(
    seed: Uint8Array,
    context?: string,
  ): Promise<AesGcmScheme> {
    // PBKDF2 derivation expects a hex string.
    const seedHex = uint8ArrayToHex(seed);
    const salt = context ?? "dstorage-v1";
    const encKey = await deriveKeyFromSignature(seedHex, salt);
    return new AesGcmScheme(encKey);
  }

  async encryptPayload(bytes: Uint8Array): Promise<Uint8Array> {
    const payload = await encrypt(this.encKey, bytes);
    return new TextEncoder().encode(serializePayload(payload));
  }

  async decryptPayload(data: Uint8Array): Promise<Uint8Array> {
    const payload = deserializePayload(new TextDecoder().decode(data));
    if (!payload) {
      throw new Error(
        "[dStorage/crypto] AES-GCM: payload is missing required fields.",
      );
    }
    return decrypt(this.encKey, payload);
  }

  async encryptStorageId(storageId: string): Promise<string> {
    const bytes = base64urlToBytes(storageId);
    const encrypted = await encryptStorageId(this.encKey, bytes);
    return bytesToBase64url(encrypted);
  }

  async decryptStorageId(encryptedId: string): Promise<string> {
    const bytes = base64urlToBytes(encryptedId);
    const decrypted = await decryptStorageId(this.encKey, bytes);
    return bytesToBase64url(decrypted);
  }
}
