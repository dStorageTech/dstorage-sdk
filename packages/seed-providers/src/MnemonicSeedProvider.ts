/**
 * @dstorage/seed-providers — MnemonicSeedProvider
 *
 * Derives an encryption seed from a BIP-39 mnemonic phrase or a raw hex seed.
 */

import { KeyDeriver, deriveKek, wrapKey, unwrapKey } from "@dstorage/crypto";
import type { EncryptionSeedProvider, WrappedDekResult } from "./types.js";

export class MnemonicSeedProvider implements EncryptionSeedProvider {
  readonly name = "mnemonic";
  private readonly deriver: KeyDeriver;

  constructor(input: { mnemonic?: string; seedHex?: string }) {
    this.deriver = new KeyDeriver(input);
  }

  /**
   * Derive the raw seed bytes from the mnemonic or hex seed.
   * Kept public for interoperability, but not part of the EncryptionSeedProvider
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
}
