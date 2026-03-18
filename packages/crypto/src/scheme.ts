/**
 * @dstorage/crypto — scheme.ts
 *
 * CryptoScheme interface and implementations for symmetric encryption.
 *
 * Both schemes accept raw seed bytes and derive their own keys internally,
 * so callers never handle key material directly.
 *
 * Supported schemes:
 *   XChaChaScheme   — XChaCha20-Poly1305 via HKDF-SHA-256 (default)
 *   AesGcmScheme    — AES-256-GCM via PBKDF2 (backward-compat reads of older records)
 *
 * CryptoSchemeRegistry holds one instance of each scheme derived from the
 * same seed, and dispatches encrypt/decrypt to the correct one based on the
 * scheme name recorded on-chain. The default scheme is used for all new writes.
 */

import {
  encryptXChaCha,
  decryptXChaCha,
  serializeXChaChaPayload,
  deserializeXChaChaPayload,
  encryptStorageIdXChaCha,
  decryptStorageIdXChaCha,
  deriveSymmetricKeyFromSeed,
} from "./pq.js";

import {
  encrypt,
  decrypt,
  serializePayload,
  deserializePayload,
  encryptStorageId as encryptStorageIdAes,
  decryptStorageId as decryptStorageIdAes,
  base64urlToBytes,
  bytesToBase64url,
} from "./encrypt.js";

import { deriveKeyFromSignature, deriveStorageIdKey } from "./keys.js";

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
    const salt = context
      ? `dstorage-xchacha-v1:${context}`
      : "dstorage-xchacha-v1";
    const key = await deriveSymmetricKeyFromSeed(seed, salt);
    return new XChaChaScheme(key);
  }

  async encryptPayload(bytes: Uint8Array): Promise<Uint8Array> {
    const payload = await encryptXChaCha(this.key, bytes);
    return new TextEncoder().encode(serializeXChaChaPayload(payload));
  }

  async decryptPayload(data: Uint8Array): Promise<Uint8Array> {
    const payload = deserializeXChaChaPayload(new TextDecoder().decode(data));
    if (!payload) {
      throw new Error(
        "[dStorage/crypto] XChaCha: payload is missing required fields.",
      );
    }
    return decryptXChaCha(this.key, payload);
  }

  async encryptStorageId(storageId: string): Promise<string> {
    const bytes = base64urlToBytes(storageId);
    const encrypted = await encryptStorageIdXChaCha(this.key, bytes);
    return bytesToBase64url(encrypted);
  }

  async decryptStorageId(encryptedId: string): Promise<string> {
    const bytes = base64urlToBytes(encryptedId);
    const decrypted = await decryptStorageIdXChaCha(this.key, bytes);
    return bytesToBase64url(decrypted);
  }
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
  private readonly storageIdKey: CryptoKey;

  private constructor(encKey: CryptoKey, storageIdKey: CryptoKey) {
    this.encKey = encKey;
    this.storageIdKey = storageIdKey;
  }

  /**
   * Derive AES-GCM keys from seed bytes using PBKDF2.
   *
   * Uses `context` (wallet address) as the PBKDF2 salt for
   * key derivation: deriveKeyFromSignature(signatureHex, address).
   * Falls back to default salts when context is absent (e.g. facade/init() mode).
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
    const contentSalt = context ?? "dstorage-v1";
    const storageIdSalt = context
      ? `dstorage-storageId-v1:${context}`
      : "dstorage-storageId-v1";
    const [encKey, storageIdKey] = await Promise.all([
      deriveKeyFromSignature(seedHex, contentSalt),
      deriveStorageIdKey(seedHex, storageIdSalt),
    ]);
    return new AesGcmScheme(encKey, storageIdKey);
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
    const encrypted = await encryptStorageIdAes(this.storageIdKey, bytes);
    return bytesToBase64url(encrypted);
  }

  async decryptStorageId(encryptedId: string): Promise<string> {
    const bytes = base64urlToBytes(encryptedId);
    const decrypted = await decryptStorageIdAes(this.storageIdKey, bytes);
    return bytesToBase64url(decrypted);
  }
}

// ── CryptoSchemeRegistry ──────────────────────────────────────────────────────

/**
 * Holds one CryptoScheme instance per supported scheme, all derived from the
 * same seed. Used by the SDK to:
 *   - encrypt with the default scheme on upload
 *   - decrypt with the correct scheme on download (based on on-chain scheme name)
 *
 * The default scheme for new writes is XChaCha20-Poly1305.
 */
export class CryptoSchemeRegistry {
  private readonly schemes: Map<EncryptionScheme, CryptoScheme>;
  private readonly _defaultSchemeName: Exclude<EncryptionScheme, "">;

  private constructor(
    schemes: Map<EncryptionScheme, CryptoScheme>,
    defaultSchemeName: Exclude<EncryptionScheme, "">,
  ) {
    this.schemes = schemes;
    this._defaultSchemeName = defaultSchemeName;
  }

  /**
   * Instantiate all supported schemes from a shared seed.
   *
   * @param seed               High-entropy seed bytes
   * @param context            Optional binding context (e.g. wallet address)
   * @param defaultSchemeName  Scheme used for new writes (default: xchacha20poly1305-v1)
   */
  static async create(
    seed: Uint8Array,
    context?: string,
    defaultSchemeName: Exclude<EncryptionScheme, ""> = "xchacha20poly1305-v1",
  ): Promise<CryptoSchemeRegistry> {
    const [xchacha, aesgcm] = await Promise.all([
      XChaChaScheme.create(seed, context),
      AesGcmScheme.create(seed, context),
    ]);
    const schemes = new Map<EncryptionScheme, CryptoScheme>([
      ["xchacha20poly1305-v1", xchacha],
      ["aes-gcm-v1", aesgcm],
    ]);
    return new CryptoSchemeRegistry(schemes, defaultSchemeName);
  }

  /** Look up a scheme by name. Returns undefined for unsupported or empty scheme names. */
  get(schemeName: EncryptionScheme): CryptoScheme | undefined {
    if (!schemeName) return undefined;
    return this.schemes.get(schemeName);
  }

  /** Return the default scheme used for all new writes. */
  getDefault(): CryptoScheme {
    const scheme = this.schemes.get(this._defaultSchemeName);
    if (!scheme) {
      throw new Error(
        `[dStorage/crypto] Default scheme '${this._defaultSchemeName}' not in registry.`,
      );
    }
    return scheme;
  }
}
