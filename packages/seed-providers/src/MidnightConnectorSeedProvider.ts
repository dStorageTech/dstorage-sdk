/**
 * @dstorage/seed-providers — MidnightConnectorSeedProvider
 *
 * Derives an encryption seed from the Midnight Lace browser wallet extension
 * using the DApp Connector v4 signData() API.
 *
 * Flow:
 *   1. Locates the wallet at window.midnight.{connectorName}.
 *   2. Calls wallet.connect(networkId) to obtain a ConnectedAPI.
 *   3. Calls api.signData(KEY_DERIVATION_MESSAGE, { encoding: 'text', keyType: 'unshielded' })
 *      to obtain the wallet's unshielded verifying key (public key).
 *   4. Returns the verifying key bytes as the seed.
 *
 * ⚠️  The verifying key is a PUBLIC value — this seed is not secret and
 * encryption derived from it is NOT safe for production. A proper fix requires
 * the wallet to expose a deterministic private seed (sr25519 signatures are
 * non-deterministic, so result.signature cannot be used for key derivation).
 *
 * Note: This provider connects to the wallet independently of MidnightChainAdapter.
 * Both connect to the same extension, but serve distinct purposes — the chain
 * adapter handles transaction signing; this provider handles key derivation only.
 *
 * Requires @midnight-ntwrk/dapp-connector-api v4+ (optional peer dependency).
 */

import { KEY_DERIVATION_MESSAGE } from "@dstorage/crypto";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import type { EncryptionSeedProvider } from "./types.js";

export interface MidnightConnectorSeedProviderConfig {
  /** Midnight network to connect to. Default: "preprod". */
  networkId?: string;
  /**
   * Name of the wallet connector to use. Default: auto-selects the first
   * available wallet at window.midnight.
   * Example: "mnLace" for the Midnight Lace extension.
   */
  connectorName?: string;
}

export class MidnightConnectorSeedProvider implements EncryptionSeedProvider {
  private readonly networkId: string;
  private readonly connectorName: string | null;

  constructor(config: MidnightConnectorSeedProviderConfig = {}) {
    this.networkId = config.networkId ?? "preprod";
    this.connectorName = config.connectorName ?? null;
  }

  async getSeed(): Promise<Uint8Array> {
    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║  ⚠️  NOT SAFE FOR PRODUCTION  ⚠️                                   ║
    // ║                                                                      ║
    // ║  WHY THIS IS DANGEROUS:                                              ║
    // ║  The unshielded verifying key is a PUBLIC value — anyone who knows   ║
    // ║  it can derive the same seed, break the encryption, and read all     ║
    // ║  data encrypted with keys derived from it.                           ║
    // ║                                                                      ║
    // ║  WHY verifyingKey IS USED INSTEAD OF signature:                      ║
    // ║  The unshielded key uses sr25519, which is non-deterministic —       ║
    // ║  signing the same message twice produces different signatures,       ║
    // ║  making signature-derived keys inconsistent across sessions.         ║
    // ║                                                                      ║
    // ║  WHAT NEEDS TO BE FIXED:                                             ║
    // ║  Replace this with a deterministic private seed once the wallet      ║
    // ║  exposes a suitable API (e.g., a dedicated key-derivation method     ║
    // ║  using a deterministic signing scheme). Until then, treat any data   ║
    // ║  encrypted under this seed as public.                                ║
    // ╚══════════════════════════════════════════════════════════════════════╝
    console.warn(
      "[dStorage] WARNING: using wallet's public verifying key as encryption seed. " +
        "This seed is not secret — encryption is NOT safe for production.",
    );

    const api = await this._connect();
    const result = await api.signData(KEY_DERIVATION_MESSAGE, {
      encoding: "text",
      keyType: "unshielded",
    });
    return hexToBytes(result.verifyingKey);
  }

  private async _connect(): Promise<ConnectedAPI> {
    const windowAny = typeof window !== "undefined" ? (window as any) : null;
    const midnightObj = windowAny?.midnight;

    if (!midnightObj || typeof midnightObj !== "object") {
      throw new Error(
        "[dStorage] Midnight wallet not detected.\n" +
          "  No Midnight wallet extension found at window.midnight.\n" +
          "  Install the Midnight Lace extension and try again.",
      );
    }

    const available = Object.entries(midnightObj).filter(
      ([, v]) =>
        v && typeof v === "object" && typeof (v as any).connect === "function",
    ) as [
      string,
      { name?: string; connect: (networkId: string) => Promise<ConnectedAPI> },
    ][];

    if (available.length === 0) {
      throw new Error(
        "[dStorage] No compatible Midnight wallets found at window.midnight.\n" +
          "  Install a Midnight-compatible wallet extension (e.g., Midnight Lace).",
      );
    }

    let [selectedId, selectedWallet] = available[0]!;
    if (this.connectorName) {
      const found = available.find(([id]) => id === this.connectorName);
      if (found) {
        [selectedId, selectedWallet] = found;
      }
    }

    try {
      return await selectedWallet.connect(this.networkId);
    } catch (err) {
      throw new Error(
        `[dStorage] Failed to connect to Midnight wallet "${selectedId}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
