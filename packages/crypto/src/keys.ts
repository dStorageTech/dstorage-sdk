/**
 * @dstorage/crypto — keys.ts
 * Derives a deterministic AES-GCM encryption key from a wallet signature,
 * and provides a KeyDeriver class for seed-phrase-based key derivation
 * (both encryption keys and blockchain signing keys).
 *
 * Flow (signature-based):
 *   1. dApp asks wallet to sign a well-known message.
 *   2. The signature (unique per wallet address) is used as PBKDF2 input.
 *   3. PBKDF2 outputs a 256-bit AES-GCM key.
 *
 * Flow (seed-based via KeyDeriver):
 *   1. User provides a BIP-39 mnemonic or raw hex seed.
 *   2. KeyDeriver validates and converts it to a 64-byte seed buffer.
 *   3. Encryption key: derived via PBKDF2 from the seed bytes.
 *   4. Midnight signing keys: derived via HDWallet (dynamic import).
 *
 * The same wallet always produces the same key — no server involved.
 */

/** The message signed by the wallet to derive the encryption key. */
export const KEY_DERIVATION_MESSAGE =
  "dStorage key derivation v1\n\nThis signature derives your encryption key. Never share it.";

// ── KeyDeriver ────────────────────────────────────────────────────────────────

/**
 * Raw seed material for a Midnight wallet, ready to be passed to ledger-v8:
 *   ZswapSecretKeys.fromSeed(zswapSeed)
 *   DustSecretKey.fromSeed(dustSeed)
 *   createKeystore(nightExternalSeed, networkId)
 */
export interface MidnightSigningKeys {
  /** Seed for shielded (Zswap) operations. */
  zswapSeed: Uint8Array;
  /** Seed for DUST fee wallet. */
  dustSeed: Uint8Array;
  /** Seed for unshielded (NightExternal) wallet. */
  nightExternalSeed: Uint8Array;
}

/**
 * Derives encryption and blockchain signing keys from a BIP-39 mnemonic or
 * a raw 32-byte or 64-byte hex seed.
 *
 * For Midnight signing keys, @midnight-ntwrk/wallet-sdk-hd must be installed
 * (optional peer dependency — dynamically imported on demand).
 */
export class KeyDeriver {
  private readonly input: { mnemonic?: string; seedHex?: string };

  constructor(input: { mnemonic?: string; seedHex?: string }) {
    if (!input.mnemonic && !input.seedHex) {
      throw new Error(
        "[dStorage/crypto] Either mnemonic or seedHex must be provided.",
      );
    }
    this.input = input;
  }

  /**
   * Return the raw seed bytes for use with CryptoSchemeRegistry.create().
   * Each scheme derives its own key from these bytes internally.
   */
  async getSeed(): Promise<Uint8Array> {
    return this.getSeedBuffer();
  }

  /** Resolves and validates the seed as a Buffer. */
  private async getSeedBuffer(): Promise<Uint8Array> {
    if (this.input.seedHex) {
      const bytes = hexToBytes(this.input.seedHex);
      if (bytes.length !== 32 && bytes.length !== 64) {
        throw new Error(
          "[dStorage/crypto] seedHex must be 32 bytes (64 hex chars) or 64 bytes (128 hex chars).",
        );
      }
      return bytes;
    }

    // mnemonic path — validate then convert
    const bip39 = await import("bip39");
    if (!bip39.validateMnemonic(this.input.mnemonic!)) {
      throw new Error("[dStorage/crypto] Invalid BIP-39 mnemonic phrase.");
    }
    const buf = await bip39.mnemonicToSeed(this.input.mnemonic!);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Derives a deterministic AES-GCM key for storage ID encryption.
   * Uses the same seed material as deriveEncryptionKey() but a different PBKDF2 salt.
   * @param salt  Optional binding salt (defaults to 'dstorage-storageId-v1').
   */
  async deriveStorageIdKey(salt?: string): Promise<CryptoKey> {
    const seed = await this.getSeedBuffer();
    const signatureHex = Array.from(seed)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return deriveStorageIdKey(signatureHex, salt ?? "dstorage-storageId-v1");
  }

  /**
   * Derives a deterministic AES-GCM encryption key from the seed via PBKDF2.
   * @param salt  Optional binding salt (defaults to 'dstorage-v1').
   */
  async deriveEncryptionKey(salt?: string): Promise<CryptoKey> {
    const seed = await this.getSeedBuffer();
    // Use the full seed bytes as signature material for PBKDF2
    const signatureHex = Array.from(seed)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return deriveKeyFromSignature(signatureHex, salt ?? "dstorage-v1");
  }

  /**
   * Derives a deterministic 32-byte XChaCha20-Poly1305 symmetric key from the wallet seed.
   * Uses HKDF-SHA-256 with a fixed global salt and a versioned, optionally context-bound
   * `info` string (RFC 5869), ensuring the derived key is cryptographically independent
   * of other keys derived from the same seed.
   *
   * The same wallet seed always produces the same key.
   *
   * @param context  Optional wallet address or other per-context binding value.
   *                 Incorporated into the HKDF `info` to bind the key to a specific account.
   * @returns 32-byte Uint8Array symmetric key
   */
  async deriveSymmetricKey(context?: string): Promise<Uint8Array> {
    const seed = await this.getSeedBuffer();
    const { deriveSymmetricKeyFromSeed } = await import("./xchacha.js");
    return deriveSymmetricKeyFromSeed(seed, context);
  }

  /**
   * Derives Midnight signing key seeds using the HD wallet derivation path:
   *   account 0 → roles [Zswap, NightExternal, Dust] → index 0
   *
   * Requires @midnight-ntwrk/wallet-sdk-hd to be installed.
   * Returns raw Uint8Array seeds; pass them to ledger-v8 to get typed keys.
   */
  async deriveMidnightSigningKeys(): Promise<MidnightSigningKeys> {
    const seed = await this.getSeedBuffer();

    // Variable indirection + @vite-ignore: prevents bundlers from resolving
    // this optional peer dep at build time; throws clearly if not installed.
    const hdId = "@midnight-ntwrk/wallet-sdk-hd";
    let HDWallet: {
      fromSeed(seed: Uint8Array): { type: string; hdWallet: HDWalletInner };
    };
    let Roles: MidnightRoles;
    try {
      const mod = await import(/* @vite-ignore */ hdId);
      HDWallet = mod.HDWallet as typeof HDWallet;
      Roles = mod.Roles as MidnightRoles;
    } catch {
      throw new Error(
        "[dStorage/crypto] @midnight-ntwrk/wallet-sdk-hd is not installed. " +
          "Run: npm install @midnight-ntwrk/wallet-sdk-hd",
      );
    }

    const result = HDWallet.fromSeed(seed);
    if (result.type !== "seedOk") {
      throw new Error(
        "[dStorage/crypto] HDWallet.fromSeed failed: invalid seed.",
      );
    }

    const derivation = result.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
      .deriveKeysAt(0);

    if (derivation.type !== "keysDerived") {
      throw new Error("[dStorage/crypto] Key derivation failed.");
    }

    // Clear sensitive HD wallet material from memory
    result.hdWallet.clear();

    return {
      zswapSeed: derivation.keys[Roles.Zswap] as Uint8Array,
      dustSeed: derivation.keys[Roles.Dust] as Uint8Array,
      nightExternalSeed: derivation.keys[Roles.NightExternal] as Uint8Array,
    };
  }
}

// ── Internal helper types ──────────────────────────────────────────────────────

interface MidnightRoles {
  Zswap: string;
  NightExternal: string;
  Dust: string;
}

interface HDWalletInner {
  selectAccount(n: number): this;
  selectRoles(roles: string[]): this;
  deriveKeysAt(index: number): {
    type: string;
    keys: Record<string, Uint8Array>;
  };
  clear(): void;
}

function getCrypto(): Crypto {
  if (typeof globalThis.crypto !== "undefined") return globalThis.crypto;
  throw new Error(
    "[dStorage/crypto] WebCrypto not available in this environment.",
  );
}

/**
 * Derive a deterministic AES-GCM CryptoKey for storage ID encryption.
 *
 * Uses the same PBKDF2 derivation path as deriveKeyFromSignature() but with
 * a different salt, so the two keys are cryptographically independent.
 *
 * @param signatureHex  Raw hex string returned by the wallet (or seed hex)
 * @param salt          Optional extra salt (default: 'dstorage-storageId-v1')
 */
export async function deriveStorageIdKey(
  signatureHex: string,
  salt = "dstorage-storageId-v1",
): Promise<CryptoKey> {
  const crypto = getCrypto();
  const sigBytes = hexToBytes(signatureHex);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    sigBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  const saltBytes = new TextEncoder().encode(salt);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// NOTE on key derivation primitive (PBKDF2 vs HKDF):
//
// We use PBKDF2 (with 100k iterations) rather than HKDF for all key derivation.
// This is an intentional choice to keep the door open for password-based derivation:
//
//   - HKDF is designed for high-entropy inputs (e.g. wallet signatures, BIP-39 seeds)
//     and is fast by design. Using HKDF on a low-entropy password would be insecure —
//     an attacker could brute-force the password space quickly.
//
//   - PBKDF2 is designed to be deliberately slow (via iteration count), making it
//     safe for both high-entropy inputs (the iterations are just wasted CPU, but safe)
//     and low-entropy passwords (where the slowness is essential security).
//
// If the SDK ever supports deriving keys from user passwords, PBKDF2 is the correct
// primitive. Switching to HKDF would be a security regression for that case, even
// though it would be more technically correct for the current high-entropy inputs.
//
// TODO (nice-to-have): If password-based derivation is never added and inputs remain
// exclusively high-entropy (signatures, BIP-39 seeds), consider switching to HKDF
// with domain-separated `info` labels (e.g. "dstorage:data:v1", "dstorage:storageId:v1")
// and dropping the unnecessary iteration overhead.

/**
 * Derive a deterministic AES-GCM CryptoKey from a hex-encoded wallet signature.
 *
 * @param signatureHex  Raw hex string returned by the wallet (e.g. eth_sign)
 * @param salt          Optional extra salt — use the wallet address for extra binding
 */
export async function deriveKeyFromSignature(
  signatureHex: string,
  salt = "dstorage-v1",
): Promise<CryptoKey> {
  const crypto = getCrypto();

  // Convert hex signature → raw bytes
  const sigBytes = hexToBytes(signatureHex);

  // Import raw bytes as PBKDF2 key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    sigBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  // Derive a 256-bit AES-GCM key
  const saltBytes = new TextEncoder().encode(salt);

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false, // not extractable — key never leaves the browser
    ["encrypt", "decrypt"],
  );

  return key;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
