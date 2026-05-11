/**
 * @dstorage/encryption — MnemonicEncryptionAdapter
 *
 * Derives an encryption seed from a BIP-39 mnemonic phrase or a raw hex seed.
 */

import { KeyDeriver, deriveKek, wrapKey, unwrapKey } from "@dstorage/crypto";
import type { EncryptionAdapter, WrappedDekResult } from "./types.js";

export class MnemonicEncryptionAdapter implements EncryptionAdapter {
  readonly name = "mnemonic";
  private readonly deriver: KeyDeriver;

  constructor(input: { mnemonic?: string; seedHex?: string }) {
    this.deriver = new KeyDeriver(input);
  }

  /**
   * Derive the raw seed bytes from the mnemonic or hex seed.
   * Kept public for interoperability, but not part of the EncryptionAdapter
   * interface — use wrapDek/unwrapDek instead.
   */
  async getSeed(): Promise<Uint8Array> {
    return this.deriver.getSeed();
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
   * The seed is passed directly to mlkemGenerateKeypairFromSeed (which expects
   * exactly 64 bytes per FIPS 203). A BIP-39 mnemonic always produces 64 bytes;
   * a 64-byte seedHex (128 hex characters) also works. A 32-byte seedHex is not
   * supported — use a mnemonic or a 64-byte seedHex instead.
   *
   * @param variant  ML-KEM variant. Default: "mlkem768".
   */
  async intoKeypairEncryptionAdapter(
    variant?: import("./KeypairEncryptionAdapter.js").MLKemVariant,
  ): Promise<import("./KeypairEncryptionAdapter.js").KeypairEncryptionAdapter> {
    const { KeypairEncryptionAdapter } =
      await import("./KeypairEncryptionAdapter.js");
    const { mlkemGenerateKeypairFromSeed } = await import("@dstorage/crypto");
    const seed = await this.getSeed();
    if (seed.length !== 64) {
      throw new Error(
        "[dStorage] MnemonicEncryptionAdapter.intoKeypairEncryptionAdapter: " +
          "ML-KEM key derivation requires a 64-byte seed. " +
          "Use a BIP-39 mnemonic phrase (always 64 bytes) or provide a 64-byte hex seed (128 hex characters).",
      );
    }
    const { pk, sk } = mlkemGenerateKeypairFromSeed(seed, variant);
    return KeypairEncryptionAdapter.fromKeypair(pk, sk, variant);
  }
}
