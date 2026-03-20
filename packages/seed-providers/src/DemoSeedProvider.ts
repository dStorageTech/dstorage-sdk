/**
 * @dstorage/seed-providers — DemoSeedProvider
 *
 * Fixed deterministic seed for testing and demos.
 * Does NOT interact with any wallet.
 *
 * Uses SHA-256(address) to produce a 32-byte seed that is stable across
 * calls for the same address, without requiring any wallet extension.
 *
 * WARNING: Never use in production. Encryption keys derived from this seed
 * are predictable and not bound to any real wallet.
 */

import type { EncryptionSeedProvider } from "./types.js";

export class DemoSeedProvider implements EncryptionSeedProvider {
  private readonly address: string;

  constructor(address = "0xDemoWallet1234") {
    this.address = address;
  }

  async getSeed(): Promise<Uint8Array> {
    const enc = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      enc.encode(`dstorage-demo:${this.address}`),
    );
    return new Uint8Array(hashBuffer);
  }
}
