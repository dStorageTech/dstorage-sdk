/**
 * @dstorage/encryption — PasswordEncryptionAdapter
 *
 * Derives an encryption seed from a user-supplied password using scrypt, a
 * memory-hard key derivation function that is resistant to GPU/ASIC brute-force.
 *
 * Security properties:
 *   - Memory-hard: each guess requires 128 MB RAM (default "v1" preset), making
 *     large-scale offline dictionary attacks prohibitively expensive.
 *   - Deterministic: same password + same salt → same 64-byte seed, always.
 *   - No stored secrets: as long as the caller retains the salt string, the seed
 *     can always be re-derived from the password alone.
 *
 * Salt design:
 *   The caller MUST supply a non-empty salt. Recommended values are app-specific
 *   domain labels ("myapp:v1"), per-user identifiers (username, tenant ID), or
 *   a combination. The SDK never supplies a default to avoid silent cross-app
 *   seed collisions when passwords are reused.
 *
 * KDF versioning — interoperable metadata:
 *   Call `adapter.getKdfParams()` to get the resolved `{ kdf, N, r, p }` values.
 *   Store these alongside encrypted data so any scrypt implementation (in any
 *   language or SDK) can re-derive the key without knowing our preset names.
 *   To reconstruct from stored params, use `PasswordEncryptionAdapter.fromKdfParams()`.
 *
 * Entropy validation:
 *   Performed at construction (synchronous, no I/O). Charset-based estimation
 *   catches trivially weak passwords (too short, single-character, very low
 *   diversity). For higher assurance, supply custom validators (e.g. zxcvbn)
 *   via `additionalValidators`.
 *
 * Side-channel note:
 *   @noble/hashes scrypt is pure-JS, community-reviewed, but not formally
 *   constant-time certified. For key *derivation* (the result is used as a key,
 *   never compared), timing side-channels are not a practical attack vector.
 *
 * OWASP 2024 scrypt recommendations:
 *   Minimum: N=32768, r=8, p=1 (32 MB)
 *   Recommended: N=131072, r=8, p=1 (128 MB) ← "v1" default
 *
 * @example
 * // New encryption context:
 * const adapter = new PasswordEncryptionAdapter({
 *   password: "correct-horse-battery-staple",
 *   salt: "myapp:alice@example.com",
 * });
 * const seed = await adapter.getSeed();
 * // Persist these alongside the encrypted blob:
 * const meta = { ...adapter.getKdfParams(), salt: "myapp:alice@example.com" };
 *
 * @example
 * // Re-derive from stored metadata (any SDK / language can do the same):
 * const adapter = PasswordEncryptionAdapter.fromKdfParams({
 *   password: "correct-horse-battery-staple",
 *   salt: meta.salt,
 *   kdf: meta.kdf,   // "scrypt"
 *   N: meta.N,
 *   r: meta.r,
 *   p: meta.p,
 * });
 * const seed = await adapter.getSeed();
 *
 * @example
 * // Constrained environment (mobile browser):
 * const adapter = new PasswordEncryptionAdapter({
 *   password: "correct-horse-battery-staple",
 *   salt: "myapp:alice@example.com",
 *   preset: "v1-lite",  // 64 MB, ~200-400ms
 * });
 */

import { scrypt } from "@noble/hashes/scrypt";
import { deriveKek, wrapKey, unwrapKey } from "@dstorage/crypto";
import type { EncryptionAdapter, WrappedDekResult } from "./types.js";

// ---------------------------------------------------------------------------
// KDF presets — convenience shorthands for input only, never stored
// ---------------------------------------------------------------------------

/**
 * Named scrypt parameter presets. Use these at construction time as a
 * convenience — they expand to concrete N/r/p values. For persistence,
 * always store the actual values from `getKdfParams()`, not the preset name.
 *
 * "v1"      — 128 MB, ~500ms–1s  — recommended for sensitive data (default)
 * "v1-lite" — 64 MB,  ~200–400ms — for constrained environments (mobile, low-RAM)
 */
export const KDF_PRESETS = {
  v1: { N: 131072, r: 8, p: 1 },
  "v1-lite": { N: 65536, r: 8, p: 1 },
} as const satisfies Record<string, ScryptParams>;

export type KdfPreset = keyof typeof KDF_PRESETS;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// ---------------------------------------------------------------------------
// Storable KDF parameters — language/SDK-agnostic metadata
// ---------------------------------------------------------------------------

/**
 * The resolved scrypt parameters to store alongside encrypted data.
 * Interoperable: any scrypt implementation in any language can re-derive
 * the key from these values without knowledge of this SDK's preset names.
 */
export interface StoredKdfParams {
  /** Always "scrypt" — identifies the KDF algorithm. */
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PasswordEncryptionAdapterConfig {
  /** The user's password. Validated for entropy at construction time. */
  password: string;

  /**
   * Domain salt — REQUIRED, must not be empty.
   *
   * Recommended: an app-specific label combined with a per-user identifier,
   * e.g. `"myapp:v1:alice@example.com"` or `"myapp:v1:" + tenantId`.
   *
   * Using a string is convenient; it is UTF-8 encoded before use.
   * Pass a Uint8Array if you prefer raw bytes.
   *
   * Same password + same salt → same seed, forever. Different salts produce
   * independent seeds even for identical passwords.
   */
  salt: string | Uint8Array;

  /**
   * Named scrypt preset. Controls N/r/p parameters.
   * Default: "v1" (N=131072, 128 MB, ~500ms–1s).
   *
   * Takes precedence over `params` when both are provided.
   * Preset names are convenience shorthands — use `getKdfParams()` to get
   * the actual values for storage.
   */
  preset?: KdfPreset;

  /**
   * Custom scrypt parameters. Only used when `preset` is not provided.
   * Prefer `preset` for well-known configurations.
   */
  params?: {
    N?: number;
    r?: number;
    p?: number;
  };

  /**
   * Minimum password length. Default: 12 characters.
   */
  minPasswordLength?: number;

  /**
   * Minimum estimated entropy in bits (charset-based estimate). Default: 60 bits.
   *
   * The built-in estimator uses character pool size × length. It catches trivially
   * weak passwords but does not detect dictionary words. Use `additionalValidators`
   * for higher assurance.
   */
  minEntropyBits?: number;

  /**
   * Optional additional password validator functions. Each receives the password
   * and should throw an Error with a helpful message if the password is rejected.
   * Run after the built-in checks. Useful for integrating zxcvbn or a blacklist.
   *
   * @example
   * additionalValidators: [(pw) => {
   *   if (zxcvbn(pw).score < 3) throw new Error("Password is too common.");
   * }]
   */
  additionalValidators?: Array<(password: string) => void>;
}

/** Config for `PasswordEncryptionAdapter.fromKdfParams()` — reconstructs from stored metadata. */
export interface FromKdfParamsConfig extends StoredKdfParams {
  password: string;
  salt: string | Uint8Array;
  minPasswordLength?: number;
  minEntropyBits?: number;
  additionalValidators?: Array<(password: string) => void>;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PasswordEncryptionAdapter implements EncryptionAdapter {
  readonly name = "password";
  private readonly password: string;
  private readonly salt: Uint8Array;
  private readonly N: number;
  private readonly r: number;
  private readonly p: number;

  constructor(config: PasswordEncryptionAdapterConfig) {
    validatePassword(
      config.password,
      config.minPasswordLength ?? 12,
      config.minEntropyBits ?? 60,
      config.additionalValidators,
    );

    this.password = config.password;
    this.salt = resolveSalt(config.salt);

    const resolved = resolveParams(config.preset, config.params);
    this.N = resolved.N;
    this.r = resolved.r;
    this.p = resolved.p;
  }

  /**
   * Reconstruct an adapter from parameters previously stored via `getKdfParams()`.
   * Use this when loading existing encrypted data — ensures the exact same N/r/p
   * are used regardless of what the current SDK defaults are.
   *
   * @example
   * const adapter = PasswordEncryptionAdapter.fromKdfParams({
   *   password,
   *   salt: meta.salt,
   *   kdf: meta.kdf,
   *   N: meta.N,
   *   r: meta.r,
   *   p: meta.p,
   * });
   */
  static fromKdfParams(config: FromKdfParamsConfig): PasswordEncryptionAdapter {
    if (config.kdf !== "scrypt") {
      throw new Error(
        `[dStorage] PasswordEncryptionAdapter.fromKdfParams: unsupported kdf "${config.kdf}". ` +
          'Only "scrypt" is supported.',
      );
    }
    return new PasswordEncryptionAdapter({
      password: config.password,
      salt: config.salt,
      params: { N: config.N, r: config.r, p: config.p },
      ...(config.minPasswordLength !== undefined && {
        minPasswordLength: config.minPasswordLength,
      }),
      ...(config.minEntropyBits !== undefined && {
        minEntropyBits: config.minEntropyBits,
      }),
      ...(config.additionalValidators !== undefined && {
        additionalValidators: config.additionalValidators,
      }),
    });
  }

  /**
   * Returns the resolved KDF parameters to store alongside encrypted data.
   *
   * These values are language- and SDK-agnostic: any scrypt implementation
   * can re-derive the key from `{ kdf, N, r, p }` + the original salt and
   * password, without any knowledge of this SDK's preset names.
   *
   * @example
   * const meta = {
   *   ...adapter.getKdfParams(),  // { kdf: "scrypt", N: 131072, r: 8, p: 1 }
   *   salt: "myapp:alice@example.com",
   * };
   * await db.save({ encryptedData, meta });
   */
  getKdfParams(): StoredKdfParams {
    return { kdf: "scrypt", N: this.N, r: this.r, p: this.p };
  }

  /**
   * Derive the raw 64-byte seed from the password using scrypt.
   * Kept public for interoperability (e.g. passing to ML-KEM keygen), but
   * not part of the EncryptionAdapter interface — use wrapDek/unwrapDek instead.
   */
  async getSeed(): Promise<Uint8Array> {
    const passwordBytes = new TextEncoder().encode(this.password);
    return scrypt(passwordBytes, this.salt, {
      N: this.N,
      r: this.r,
      p: this.p,
      dkLen: 64,
    });
  }

  async wrapDek(dek: Uint8Array): Promise<WrappedDekResult> {
    const kek = await deriveKek(await this.getSeed());
    return {
      algorithm: "xchacha20poly1305-v1",
      kekDerivation: "hkdf-sha256-v1",
      wrappedDek: await wrapKey(dek, kek),
    };
  }

  async unwrapDek({ wrappedDek }: WrappedDekResult): Promise<Uint8Array> {
    const kek = await deriveKek(await this.getSeed());
    return unwrapKey(wrappedDek, kek);
  }

  /**
   * Deterministically derive a ML-KEM keypair from this adapter's seed.
   *
   * The 64-byte scrypt seed is passed directly to mlkemGenerateKeypairFromSeed
   * (which expects exactly 64 bytes as the (d‖z) seed per FIPS 203).
   * Same password + salt + variant always produces the same keypair.
   *
   * @param variant  ML-KEM variant. Default: "mlkem768".
   */
  async intoKeypairEncryptionAdapter(
    variant?: import("./KeypairEncryptionAdapter.js").MLKemVariant,
  ): Promise<import("./KeypairEncryptionAdapter.js").KeypairEncryptionAdapter> {
    // Imported inside the method body to avoid circular module initialization.
    const { KeypairEncryptionAdapter } =
      await import("./KeypairEncryptionAdapter.js");
    const { mlkemGenerateKeypairFromSeed } = await import("@dstorage/crypto");
    const seed64 = await this.getSeed();
    const { pk, sk } = mlkemGenerateKeypairFromSeed(seed64, variant);
    return KeypairEncryptionAdapter.fromKeypair(pk, sk, variant);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSalt(salt: string | Uint8Array): Uint8Array {
  const bytes =
    typeof salt === "string" ? new TextEncoder().encode(salt) : salt;
  if (bytes.length === 0) {
    throw new Error(
      "[dStorage] PasswordEncryptionAdapter: salt must not be empty. " +
        'Provide an app-specific domain label, e.g. "myapp:v1:alice@example.com".',
    );
  }
  return bytes;
}

function resolveParams(
  preset: KdfPreset | undefined,
  params: PasswordEncryptionAdapterConfig["params"],
): ScryptParams {
  if (preset !== undefined) {
    if (!(preset in KDF_PRESETS)) {
      throw new Error(
        `[dStorage] PasswordEncryptionAdapter: unknown preset "${preset}". ` +
          `Valid presets: ${Object.keys(KDF_PRESETS).join(", ")}.`,
      );
    }
    return KDF_PRESETS[preset];
  }
  return {
    N: params?.N ?? KDF_PRESETS["v1"].N,
    r: params?.r ?? KDF_PRESETS["v1"].r,
    p: params?.p ?? KDF_PRESETS["v1"].p,
  };
}

function estimateEntropyBits(password: string): number {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 32;
  return pool === 0 ? 0 : Math.log2(pool) * password.length;
}

function validatePassword(
  password: string,
  minLength: number,
  minEntropyBits: number,
  additionalValidators?: Array<(password: string) => void>,
): void {
  if (password.length < minLength) {
    throw new Error(
      `[dStorage] Password too short: ${password.length} character(s) (minimum ${minLength}). ` +
        "Use a longer passphrase.",
    );
  }

  if (new Set(password).size === 1) {
    throw new Error(
      "[dStorage] Password is too weak: all characters are identical.",
    );
  }

  const entropy = estimateEntropyBits(password);
  if (entropy < minEntropyBits) {
    throw new Error(
      `[dStorage] Password entropy too low: ~${Math.round(entropy)} bits ` +
        `(minimum ${minEntropyBits} bits). ` +
        "Use a longer password with a mix of uppercase, lowercase, digits, and symbols.",
    );
  }

  if (additionalValidators) {
    for (const validate of additionalValidators) {
      validate(password);
    }
  }
}
