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
 *   "xchacha20poly1305-v1" — XChaCha20-Poly1305 (per-upload random DEK, wrapped in keyEnvelope); default
 *   ""                     — No encryption; storageId and content are stored as plaintext (public data)
 */
export type EncryptionScheme = "xchacha20poly1305-v1" | "";

// ── WrappedDekResult ──────────────────────────────────────────────────────────

/**
 * The result of wrapping a DEK under a provider's key material.
 * Returned by every EncryptionSeedProvider.wrapDek() implementation and
 * stored as a KeyWrapper entry inside the on-chain KeyEnvelope.
 *
 * Symmetric providers set algorithm/kekDerivation for their own scheme and
 * leave kemCiphertext undefined. Asymmetric providers (ML-KEM) additionally
 * populate kemCiphertext with the KEM ciphertext needed for decapsulation.
 */
export interface WrappedDekResult {
  /** Algorithm identifier, e.g. "xchacha20poly1305-v1" or "mlkem768-xchacha20poly1305-v1". */
  algorithm: string;
  /** How the KEK was derived from its source material, e.g. "hkdf-sha256-v1". */
  kekDerivation: string;
  /** base64url-encoded wrapped DEK ciphertext. */
  wrappedDek: string;
  /** base64url-encoded KEM ciphertext — present only for asymmetric providers. */
  kemCiphertext?: string;
}

// ── CryptoScheme interface ────────────────────────────────────────────────────

/**
 * Interface for a symmetric encryption scheme.
 *
 * Implementations are instantiated from a random DEK via a static factory
 * (e.g. XChaChaScheme.fromKey(dek)) for per-upload encryption.
 */
export interface CryptoScheme {
  /** Scheme identifier recorded on-chain. */
  readonly schemeName: Exclude<EncryptionScheme, "">;

  /**
   * Encrypt raw bytes and return a self-contained serialized payload
   * ready to be uploaded to off-chain storage.
   *
   * `aad` is bound into the Poly1305 auth tag and must match on decrypt.
   * Use PAYLOAD_AAD for single-shot uploads and manifests; use chunkAad(i, n)
   * for individual chunks so a malicious gateway cannot swap chunk order.
   */
  encryptPayload(bytes: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;

  /**
   * Deserialize and decrypt a payload previously produced by encryptPayload().
   * Throws if the payload format is invalid, the auth tag fails, or the AAD mismatches.
   */
  decryptPayload(data: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;

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
  if (!/^[A-Za-z0-9_-]*$/.test(b64url)) {
    throw new Error(
      `[dStorage/crypto] malformed base64url input — unexpected characters in "${b64url.slice(0, 32)}${b64url.length > 32 ? "…" : ""}"`,
    );
  }
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
