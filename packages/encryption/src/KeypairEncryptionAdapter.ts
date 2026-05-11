/**
 * @dstorage/encryption — KeypairEncryptionAdapter
 *
 * Post-quantum asymmetric DEK wrapping via ML-KEM (CRYSTALS-Kyber, NIST FIPS 203).
 *
 * Unlike symmetric adapters (password, mnemonic), this adapter uses a
 * public/secret key pair:
 *   - wrapDek()   requires only the Public Key (PK) — safe for upload-only parties
 *   - unwrapDek() requires the Secret Key (SK) — held only by the authorized reader
 *
 * Variants:
 *   "mlkem512"  — 128-bit post-quantum security
 *   "mlkem768"  — 192-bit post-quantum security (NIST recommended, default)
 *   "mlkem1024" — 256-bit post-quantum security
 *
 * Key sizes (mlkem768):
 *   Public key: 1184 bytes | Secret key: 2400 bytes | KEM ciphertext: 1088 bytes
 *
 * @example
 * // Generate a fresh keypair:
 * const { adapter, secretKey } = KeypairEncryptionAdapter.generateKeypair();
 * // Share adapter.publicKey with upload-only parties
 *
 * @example
 * // Deterministic keypair from a password (same inputs → same keypair):
 * const adapter = await KeypairEncryptionAdapter.fromPassword("s3cr3t!", "myapp:v1");
 *
 * @example
 * // Upload with PK only:
 * const uploader = KeypairEncryptionAdapter.fromPublicKey(pk);
 * // Retrieve with full keypair:
 * const reader = KeypairEncryptionAdapter.fromKeypair(pk, sk);
 */

import {
  mlkemGenerateKeypair,
  mlkemWrapDek,
  mlkemUnwrapDek,
} from "@dstorage/crypto";
import type { MLKemVariant } from "@dstorage/crypto";
import type { EncryptionAdapter, WrappedDekResult } from "./types.js";

export type { MLKemVariant };

export class KeypairEncryptionAdapter implements EncryptionAdapter {
  readonly name: string;
  readonly publicKey: Uint8Array;
  private readonly secretKey: Uint8Array | undefined;
  private readonly variant: MLKemVariant;

  private constructor(
    pk: Uint8Array,
    sk: Uint8Array | undefined,
    variant: MLKemVariant,
  ) {
    this.publicKey = pk;
    this.secretKey = sk;
    this.variant = variant;
    this.name = variant;
  }

  /**
   * Upload-only adapter — holds only the Public Key.
   * wrapDek() works normally; unwrapDek() throws (no SK available).
   */
  static fromPublicKey(
    pk: Uint8Array,
    variant: MLKemVariant = "mlkem768",
  ): KeypairEncryptionAdapter {
    return new KeypairEncryptionAdapter(pk, undefined, variant);
  }

  /**
   * Full adapter — holds both Public Key and Secret Key.
   * Both wrapDek() and unwrapDek() work.
   */
  static fromKeypair(
    pk: Uint8Array,
    sk: Uint8Array,
    variant: MLKemVariant = "mlkem768",
  ): KeypairEncryptionAdapter {
    return new KeypairEncryptionAdapter(pk, sk, variant);
  }

  /**
   * Generate a fresh random ML-KEM keypair.
   *
   * Returns the adapter (with both PK+SK) plus the raw keys so the caller
   * can persist the secret key and share the public key separately.
   *
   * @param variant  Default: "mlkem768".
   */
  static generateKeypair(variant: MLKemVariant = "mlkem768"): {
    adapter: KeypairEncryptionAdapter;
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  } {
    const { pk, sk } = mlkemGenerateKeypair(variant);
    return {
      adapter: new KeypairEncryptionAdapter(pk, sk, variant),
      publicKey: pk,
      secretKey: sk,
    };
  }

  /**
   * Deterministically derive a ML-KEM keypair from a BIP-39 mnemonic phrase or hex seed.
   *
   * Delegates to MnemonicEncryptionAdapter.intoKeypairEncryptionAdapter() so all
   * mnemonic/seed handling lives in a single place.
   *
   * Same inputs + variant always produce the same keypair.
   *
   * Note: 32-byte seedHex (64 hex characters) is not supported — use a mnemonic
   * or a 64-byte seedHex (128 hex characters) instead.
   *
   * @param input    { mnemonic } or { seedHex } (64-byte hex, 128 chars)
   * @param variant  Default: "mlkem768"
   */
  static async fromMnemonic(
    input: { mnemonic?: string; seedHex?: string },
    variant: MLKemVariant = "mlkem768",
  ): Promise<KeypairEncryptionAdapter> {
    const { MnemonicEncryptionAdapter } =
      await import("./MnemonicEncryptionAdapter.js");
    const ms = new MnemonicEncryptionAdapter(input);
    return ms.intoKeypairEncryptionAdapter(variant);
  }

  /**
   * Deterministically derive a ML-KEM keypair from a password and salt.
   *
   * Delegates to PasswordEncryptionAdapter.intoKeypairEncryptionAdapter() so all
   * password handling (scrypt params, entropy validation, 64-byte seed derivation)
   * lives in a single place.
   *
   * Same password + salt + variant always produces the same keypair.
   *
   * @param password  User password (validated for entropy)
   * @param salt      Domain salt — must not be empty
   * @param variant   Default: "mlkem768"
   * @param params    Optional custom scrypt params
   */
  static async fromPassword(
    password: string,
    salt: string,
    variant: MLKemVariant = "mlkem768",
    params?: { N?: number; r?: number; p?: number },
  ): Promise<KeypairEncryptionAdapter> {
    // Imported inside the method body to avoid circular module initialization.
    const { PasswordEncryptionAdapter } =
      await import("./PasswordEncryptionAdapter.js");
    const ps = new PasswordEncryptionAdapter({
      password,
      salt,
      ...(params ? { params } : {}),
    });
    return ps.intoKeypairEncryptionAdapter(variant);
  }

  async wrapDek(dek: Uint8Array): Promise<WrappedDekResult> {
    return mlkemWrapDek(dek, this.publicKey, this.variant);
  }

  async unwrapDek(data: WrappedDekResult): Promise<Uint8Array> {
    if (!this.secretKey) {
      throw new Error(
        `[dStorage] KeypairEncryptionAdapter(${this.variant}): cannot unwrapDek — ` +
          "no Secret Key is available. Use fromKeypair() or fromPassword() to create an adapter with a SK.",
      );
    }
    return mlkemUnwrapDek(data, this.secretKey);
  }
}
