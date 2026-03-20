/**
 * @dstorage/seed-providers — types.ts
 *
 * The EncryptionSeedProvider interface: the single abstraction for how the
 * dStorage SDK obtains the raw seed bytes used to derive encryption keys.
 *
 * dStorage is not a wallet — it only borrows a wallet's signing capability
 * to produce a deterministic, wallet-bound seed. Which wallet is used, and
 * how it signs, is entirely up to the application via this interface.
 */

/**
 * Provides raw seed bytes for dStorage encryption key derivation.
 *
 * Implementations:
 *   MetaMaskSeedProvider            — personal_sign via MetaMask / any EIP-1193 wallet
 *   MidnightConnectorSeedProvider   — signData() via Midnight Lace browser extension
 *   MnemonicSeedProvider            — BIP-39 mnemonic or hex seed (temporary, facade mode only)
 *   DemoSeedProvider                — fixed deterministic seed for testing/demos
 */
export interface EncryptionSeedProvider {
  getSeed(): Promise<Uint8Array>;
}
