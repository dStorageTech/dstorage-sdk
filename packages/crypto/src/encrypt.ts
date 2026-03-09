/**
 * @dstorage/crypto — encrypt.ts
 * AES-GCM encryption/decryption using the WebCrypto API.
 * Works in both browser (native) and Node.js 18+ (globalThis.crypto).
 */

/** Shape of an encrypted payload stored alongside its IV. */
export interface EncryptedPayload {
  /** AES-GCM ciphertext as base64 string */
  ciphertext: string;
  /** 12-byte initialisation vector as base64 string */
  iv: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Base64url encoding (browser-safe, no Buffer) ──────────────────────────────

/** Decode a base64url string to a Uint8Array. */
export function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode a Uint8Array to a base64url string (no padding). */
export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── Core API ─────────────────────────────────────────────────────────────────

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
  } catch (_) {
    return null;
  }
}

// ── StorageId encryption (AES-GCM, authenticated) ────────────────────────────
//
// Uses AES-GCM (AEAD) so the on-chain encrypted storageId is tamper-evident:
// any bit-flip is detected during decryption via the authentication tag.
//
// The 60-byte on-chain payload layout is:
//   [ ciphertext: 32 bytes | IV: 12 bytes | auth tag: 16 bytes ]
//
// A fresh random IV is generated per encryption (standard AES-GCM practice).
// The storageId key is derived from the same root material as the data encryption
// key but with a different PBKDF2 salt ("dstorage-storageId-v1"), ensuring
// cryptographic independence between the two keys.

/**
 * Encrypt a 32-byte storage ID using AES-GCM.
 * Output is exactly 60 bytes: [ciphertext(32) | IV(12) | tag(16)].
 * Use deriveStorageIdKey() to obtain the required AES-GCM CryptoKey.
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
