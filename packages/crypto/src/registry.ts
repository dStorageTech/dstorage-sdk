/**
 * @dstorage/crypto — registry.ts
 *
 * CryptoSchemeRegistry holds one CryptoScheme instance per supported scheme,
 * all derived from the same seed. Used by the SDK to:
 *   - encrypt with the default scheme on upload
 *   - decrypt with the correct scheme on download (based on on-chain scheme name)
 *
 * The default scheme for new writes is XChaCha20-Poly1305.
 */

import type { CryptoScheme, EncryptionScheme } from "./types.js";
import { XChaChaScheme } from "./xchacha.js";
import { AesGcmScheme } from "./aesgcm.js";

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
