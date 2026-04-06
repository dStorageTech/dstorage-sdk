/**
 * @dstorage/seed-providers — types.ts
 *
 * The EncryptionSeedProvider interface: the single abstraction for how the
 * dStorage SDK obtains the raw seed bytes used to derive encryption keys.
 *
 * The seed can come from any entropy source — a user password, a wallet
 * signature, a BIP-39 mnemonic, or a fixed test value. Which source is used
 * is entirely up to the application via this interface.
 */

/**
 * Provides raw seed bytes for dStorage encryption key derivation.
 *
 * Implementations:
 *   PasswordSeedProvider  — scrypt-derived from a user password + caller-supplied salt
 *   MnemonicSeedProvider  — BIP-39 mnemonic or hex seed
 */
export interface EncryptionSeedProvider {
  /** Stable identifier for this provider type, used as the wrapper name in key envelopes. */
  readonly name: string;
  getSeed(): Promise<Uint8Array>;
}
