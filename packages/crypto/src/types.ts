/**
 * @dstorage/crypto — types.ts
 *
 * Core types and interfaces for the crypto package:
 *   - EncryptionScheme  — on-chain scheme identifier
 *   - CryptoScheme      — interface every scheme implementation must satisfy
 *   - base64url helpers — shared encoding utilities used across scheme implementations
 */

// ── EncryptionScheme ──────────────────────────────────────────────────────────

/**
 * Identifies the encryption algorithm used to encrypt a storageId and content.
 * Recorded on-chain in ReferenceEntry.encryptionScheme so the SDK can dispatch
 * the correct decryption function at read time.
 *
 * Values:
 *   "xchacha20poly1305-v1" — XChaCha20-Poly1305 (HKDF-SHA-256-derived key); default
 *   "aes-gcm-v1"           — AES-256-GCM (PBKDF2-derived key); supported for backward compat reads
 *   ""                     — No encryption; storageId and content are stored as plaintext (public data)
 */
export type EncryptionScheme = "xchacha20poly1305-v1" | "aes-gcm-v1" | "";

// ── CryptoScheme interface ────────────────────────────────────────────────────

/**
 * Interface for a symmetric encryption scheme.
 *
 * Each implementation is instantiated from raw seed bytes via a static factory
 * (e.g. XChaChaScheme.create(seed, context)) and derives its own key internally.
 * The SDK holds a CryptoSchemeRegistry containing one instance per supported scheme.
 */
export interface CryptoScheme {
  /** Scheme identifier recorded on-chain. */
  readonly schemeName: Exclude<EncryptionScheme, "">;

  /**
   * Encrypt raw bytes and return a self-contained serialized payload
   * ready to be uploaded to off-chain storage.
   */
  encryptPayload(bytes: Uint8Array): Promise<Uint8Array>;

  /**
   * Deserialize and decrypt a payload previously produced by encryptPayload().
   * Throws if the payload format is invalid or decryption fails.
   */
  decryptPayload(data: Uint8Array): Promise<Uint8Array>;

  /**
   * Encrypt a 43-char base64url storage ID (32 decoded bytes) for on-chain storage.
   * Returns a base64url-encoded encrypted form.
   */
  encryptStorageId(storageId: string): Promise<string>;

  /**
   * Decrypt a storage ID previously encrypted by encryptStorageId().
   * Returns the original 43-char base64url storage ID.
   */
  decryptStorageId(encryptedId: string): Promise<string>;
}

// ── Base64url helpers ─────────────────────────────────────────────────────────

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
