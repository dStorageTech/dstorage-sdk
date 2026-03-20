/**
 * @dstorage/seed-providers — MnemonicSeedProvider
 *
 * Derives an encryption seed from a BIP-39 mnemonic phrase or a raw hex seed.
 *
 * @deprecated
 * This provider is a TEMPORARY scaffold for Node.js / facade mode while proper
 * wallet support for server-side environments is being built.
 *
 * dStorage is not a wallet and should never hold or request credentials from
 * the user. The end goal is that all seed providers derive keys from wallet
 * signatures — the wallet holds the secret, dStorage only borrows its signing
 * capability. MnemonicSeedProvider exists only because there is currently no
 * wallet-extension-based signing available in Node.js (CLI / server) contexts.
 *
 * When a proper signing interface for headless/server wallets is available,
 * this provider will be removed.
 */

import { KeyDeriver } from "@dstorage/crypto";
import type { EncryptionSeedProvider } from "./types.js";

/** @deprecated See module doc — temporary scaffold for facade/Node.js mode only. */
export class MnemonicSeedProvider implements EncryptionSeedProvider {
  private readonly deriver: KeyDeriver;

  /** @deprecated */
  constructor(input: { mnemonic?: string; seedHex?: string }) {
    this.deriver = new KeyDeriver(input);
  }

  async getSeed(): Promise<Uint8Array> {
    return this.deriver.getSeed();
  }
}
