/**
 * @dstorage/seed-providers — MnemonicSeedProvider
 *
 * Derives an encryption seed from a BIP-39 mnemonic phrase or a raw hex seed.
 */

import { KeyDeriver } from "@dstorage/crypto";
import type { EncryptionSeedProvider } from "./types.js";

export class MnemonicSeedProvider implements EncryptionSeedProvider {
  private readonly deriver: KeyDeriver;

  constructor(input: { mnemonic?: string; seedHex?: string }) {
    this.deriver = new KeyDeriver(input);
  }

  async getSeed(): Promise<Uint8Array> {
    return this.deriver.getSeed();
  }
}
