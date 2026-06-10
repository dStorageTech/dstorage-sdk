/**
 * @dstorage/encryption — MnemonicEncryptionAdapter
 *
 * Derives an encryption seed from a BIP-39 mnemonic phrase or a raw hex seed.
 *
 * The raw seed bytes are imported as a non-extractable HKDF CryptoKey at
 * construction time and zeroed immediately after. Only the CryptoKey handle
 * is retained for the lifetime of the adapter; raw bytes never remain in a
 * JS-accessible heap variable.
 */

import {
  KeyDeriver,
  wrapKey,
  unwrapKey,
  DStorageError,
} from "@dstorage/crypto";
import { deriveKek } from "@dstorage/crypto";
import type { EncryptionAdapter, WrappedDekResult } from "./types.js";
import { EncryptionErrorCode } from "./errors.js";

export class MnemonicEncryptionAdapter implements EncryptionAdapter {
  readonly name = "mnemonic";
  /**
   * Non-extractable HKDF CryptoKey imported from the BIP-39 / hex seed.
   * Raw seed bytes are zeroed immediately after import.
   */
  private readonly kekMaterialPromise: Promise<CryptoKey>;

  constructor(input: { mnemonic?: string; seedHex?: string }) {
    if (input.mnemonic !== undefined) {
      const wordCount = input.mnemonic.trim().split(/\s+/).length;
      if (wordCount < 24) {
        throw new DStorageError(
          EncryptionErrorCode.MNEMONIC_TOO_SHORT,
          `[dStorage] MnemonicEncryptionAdapter: a 24-word BIP-39 mnemonic is required ` +
            `(${wordCount} word${wordCount === 1 ? "" : "s"} provided). ` +
            `Shorter mnemonics provide insufficient entropy for post-quantum-safe key derivation — ` +
            `a 12-word mnemonic gives only 64-bit PQ security (below NIST's 128-bit minimum). ` +
            `Use a 24-word mnemonic or pass a 64-byte seedHex instead.`,
        );
      }
    }
    const deriver = new KeyDeriver(input);
    this.kekMaterialPromise = deriver.getSeed().then((seed) =>
      // Uint8Array.from() produces Uint8Array<ArrayBuffer> required by Web Crypto.
      globalThis.crypto.subtle
        .importKey("raw", Uint8Array.from(seed), "HKDF", false, ["deriveBits"])
        .then(
          (key) => {
            seed.fill(0);
            return key;
          },
          (err) => {
            seed.fill(0);
            throw err;
          },
        ),
    );
  }

  async wrapDek(dek: Uint8Array): Promise<WrappedDekResult> {
    const kekMaterial = await this.kekMaterialPromise;
    const kek = await deriveKek(kekMaterial);
    try {
      return {
        algorithm: "xchacha20poly1305-v1",
        kekDerivation: "hkdf-sha256-v1",
        wrappedDek: await wrapKey(dek, kek),
      };
    } finally {
      kek.fill(0);
    }
  }

  async unwrapDek({ wrappedDek }: WrappedDekResult): Promise<Uint8Array> {
    const kekMaterial = await this.kekMaterialPromise;
    const kek = await deriveKek(kekMaterial);
    try {
      return unwrapKey(wrappedDek, kek);
    } finally {
      kek.fill(0);
    }
  }

  /**
   * Deterministically derive a ML-KEM keypair from this adapter's key material.
   *
   * Uses Web Crypto HKDF to derive a 64-byte ML-KEM seed from the stored
   * CryptoKey with info="dstorage:mlkem-seed:v1", domain-separated from the
   * symmetric KEK derivation path. The same derivation applies to all seed
   * types (mnemonic or hex), producing consistent, domain-separated keypairs.
   *
   * @param variant  ML-KEM variant. Default: "mlkem768".
   */
  async intoKeypairEncryptionAdapter(
    context: string,
    variant?: import("./KeypairEncryptionAdapter.js").MLKemVariant,
  ): Promise<import("./KeypairEncryptionAdapter.js").KeypairEncryptionAdapter> {
    const { KeypairEncryptionAdapter } =
      await import("./KeypairEncryptionAdapter.js");
    const { mlkemGenerateKeypairFromSeed } = await import("@dstorage/crypto");
    const kekMaterial = await this.kekMaterialPromise;
    // noble hkdf(sha256, seed, undefined, info, 64) uses a 32-zero-byte salt.
    // Web Crypto equivalent: salt = new Uint8Array(32).
    const mlkemBits = await globalThis.crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode("dstorage:mlkem-seed:v1"),
      },
      kekMaterial,
      512, // 64 bytes
    );
    const mlkemSeed = new Uint8Array(mlkemBits);
    try {
      const { pk, sk } = mlkemGenerateKeypairFromSeed(mlkemSeed, variant);
      return KeypairEncryptionAdapter.fromKeypair(pk, sk, context, variant);
    } finally {
      mlkemSeed.fill(0);
    }
  }
}
