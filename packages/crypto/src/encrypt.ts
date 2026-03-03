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
export function deserializePayload(raw: string): EncryptedPayload {
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
}
