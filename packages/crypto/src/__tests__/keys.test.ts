import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  deriveKeyFromSignature,
  KEY_DERIVATION_MESSAGE,
  KeyDeriver,
} from "../keys.js";
import { ZswapSecretKeys, DustSecretKey } from "@midnight-ntwrk/ledger-v7";
import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  DustAddress,
} from "@midnight-ntwrk/wallet-sdk-address-format";
import { createKeystore } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";

// A valid 65-byte Ethereum-style signature in hex (no 0x prefix)
const SIG_HEX = "ab".repeat(32) + "cd".repeat(32) + "ef01";
const SIG_WITH_0X = "0x" + SIG_HEX;
const ALT_SIG = "de".repeat(65);

// ── KEY_DERIVATION_MESSAGE ────────────────────────────────────────────────────

describe("KEY_DERIVATION_MESSAGE", () => {
  it("is a non-empty string", () => {
    expect(typeof KEY_DERIVATION_MESSAGE).toBe("string");
    expect(KEY_DERIVATION_MESSAGE.length).toBeGreaterThan(0);
  });

  it("starts with the expected version prefix", () => {
    expect(
      KEY_DERIVATION_MESSAGE.startsWith("dStorage key derivation v1"),
    ).toBe(true);
  });

  it("is stable across imports (constant)", () => {
    const msg1 = KEY_DERIVATION_MESSAGE;
    const msg2 = KEY_DERIVATION_MESSAGE;
    expect(msg1).toBe(msg2);
  });
});

// ── deriveKeyFromSignature ────────────────────────────────────────────────────

describe("deriveKeyFromSignature", () => {
  it("returns a CryptoKey", async () => {
    const key = await deriveKeyFromSignature(SIG_HEX);
    expect(key).toBeDefined();
    // CryptoKey is a native object — check distinguishing properties
    expect(typeof key).toBe("object");
    expect(key.type).toBe("secret");
  });

  it("key algorithm is AES-GCM", async () => {
    const key = await deriveKeyFromSignature(SIG_HEX);
    expect(key.algorithm.name).toBe("AES-GCM");
  });

  it("key is non-extractable (never leaves memory)", async () => {
    const key = await deriveKeyFromSignature(SIG_HEX);
    expect(key.extractable).toBe(false);
  });

  it("key usages include encrypt and decrypt", async () => {
    const key = await deriveKeyFromSignature(SIG_HEX);
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
    expect(key.usages).toHaveLength(2);
  });

  it("strips 0x prefix and produces the same key as bare hex", async () => {
    // Derive two keys: one with 0x, one without — should behave identically
    const keyA = await deriveKeyFromSignature(SIG_HEX);
    const keyB = await deriveKeyFromSignature(SIG_WITH_0X);

    // Encrypt with A, decrypt with B — should succeed
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("test payload");
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyA,
      data,
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      keyB,
      cipher,
    );
    expect(new TextDecoder().decode(plain)).toBe("test payload");
  });

  it("is deterministic: same signature + salt always produces equivalent key", async () => {
    const keyA = await deriveKeyFromSignature(SIG_HEX, "0xAlice");
    const keyB = await deriveKeyFromSignature(SIG_HEX, "0xAlice");

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("determinism check");
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyA,
      data,
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      keyB,
      cipher,
    );
    expect(new TextDecoder().decode(plain)).toBe("determinism check");
  });

  it("different signatures produce different keys", async () => {
    const keyA = await deriveKeyFromSignature(SIG_HEX, "0xAlice");
    const keyB = await deriveKeyFromSignature(ALT_SIG, "0xAlice");

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("secret");
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyA,
      data,
    );

    // Decrypting with wrong key must fail
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, keyB, cipher),
    ).rejects.toBeDefined();
  });

  it("different salts produce different keys for the same signature", async () => {
    const keyA = await deriveKeyFromSignature(SIG_HEX, "0xAddress1");
    const keyB = await deriveKeyFromSignature(SIG_HEX, "0xAddress2");

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("secret");
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyA,
      data,
    );

    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, keyB, cipher),
    ).rejects.toBeDefined();
  });

  it('uses default salt "dstorage-v1" when no salt provided', async () => {
    // Key with default salt should equal key with explicit 'dstorage-v1' salt
    const keyDefault = await deriveKeyFromSignature(SIG_HEX);
    const keyExplicit = await deriveKeyFromSignature(SIG_HEX, "dstorage-v1");

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode("default salt check");
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyDefault,
      data,
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      keyExplicit,
      cipher,
    );
    expect(new TextDecoder().decode(plain)).toBe("default salt check");
  });

  it("throws a descriptive error when WebCrypto is not available", async () => {
    // globalThis.crypto is a read-only getter in Node.js, so use vi.stubGlobal
    vi.stubGlobal("crypto", undefined);

    try {
      await expect(deriveKeyFromSignature(SIG_HEX)).rejects.toThrow(
        "[dStorage/crypto] WebCrypto not available in this environment.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts short hex signature (minimum valid input)", async () => {
    // 2-char hex = 1 byte — technically valid for PBKDF2 key material
    const key = await deriveKeyFromSignature("ff");
    expect(key.type).toBe("secret");
  });

  it("handles odd-length hex gracefully (parseInt stops at NaN boundary)", async () => {
    // Not a great signature but should not throw
    const key = await deriveKeyFromSignature("aabb");
    expect(key.type).toBe("secret");
  });
});

// ── KeyDeriver — Midnight address derivation ──────────────────────────────────
// Verifies that a known 32-byte hex seed produces the expected on-chain
// addresses on both the `undeployed` (local) and `preprod` networks.
// Reference: counter-cli uses HDWallet.fromSeed(Buffer.from(seed, 'hex'))
// with the raw 32 bytes — our KeyDeriver must do the same (no padding).

describe("KeyDeriver — Midnight address derivation (hex seed)", () => {
  // 32 bytes (64 hex chars) — the shortest valid HD-wallet seed
  const SEED_HEX =
    "0000000000000000000000000000000000000000000000000000000000000001";

  let zswapSeed: Uint8Array;
  let dustSeed: Uint8Array;
  let nightExternalSeed: Uint8Array;

  beforeAll(async () => {
    const deriver = new KeyDeriver({ seedHex: SEED_HEX });
    ({ zswapSeed, dustSeed, nightExternalSeed } =
      await deriver.deriveMidnightSigningKeys());
  });

  /** Derive all three wallet addresses for a given network. */
  function deriveAddresses(networkId: string) {
    // Shielded (ZSwap): coin public key + encryption public key → ShieldedAddress
    const zswapKeys = ZswapSecretKeys.fromSeed(zswapSeed);
    const cpk = ShieldedCoinPublicKey.fromHexString(zswapKeys.coinPublicKey);
    const epk = ShieldedEncryptionPublicKey.fromHexString(
      zswapKeys.encryptionPublicKey,
    );
    const shielded = ShieldedAddress.codec
      .encode(networkId, new ShieldedAddress(cpk, epk))
      .toString();

    // Unshielded (NightExternal): derive keystore, read its bech32m address
    const unshielded = createKeystore(nightExternalSeed, networkId)
      .getBech32Address()
      .toString();

    // Dust: derive public key from secret key, encode to bech32m
    const dustKey = DustSecretKey.fromSeed(dustSeed);
    const dust = DustAddress.encodePublicKey(networkId, dustKey.publicKey);

    return { shielded, unshielded, dust };
  }

  describe("undeployed network", () => {
    it("derives the correct shielded (ZSwap) address", () => {
      const { shielded } = deriveAddresses("undeployed");
      expect(shielded).toBe(
        "mn_shield-addr_undeployed1r020sfa7jllsz0z2wqhykz8npmphsu5223nsea7vjt9ekxs5almtvtnrpgpszud4uyd0yjrlqyp7v5xvwqljsng2g79j5w4al9c4kuqy0xtw4",
      );
    });

    it("derives the correct unshielded address", () => {
      const { unshielded } = deriveAddresses("undeployed");
      expect(unshielded).toBe(
        "mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sk96u7s",
      );
    });

    it("derives the correct dust address", () => {
      const { dust } = deriveAddresses("undeployed");
      expect(dust).toBe(
        "mn_dust_undeployed1w0l54txthpu8q05j9j9ttk3j5dyu5766dc9zkz2s435vdglzwdr35dw790y",
      );
    });
  });

  describe("preprod network", () => {
    it("derives the correct shielded (ZSwap) address", () => {
      const { shielded } = deriveAddresses("preprod");
      expect(shielded).toBe(
        "mn_shield-addr_preprod1r020sfa7jllsz0z2wqhykz8npmphsu5223nsea7vjt9ekxs5almtvtnrpgpszud4uyd0yjrlqyp7v5xvwqljsng2g79j5w4al9c4kuqat4jja",
      );
    });

    it("derives the correct unshielded address", () => {
      const { unshielded } = deriveAddresses("preprod");
      expect(unshielded).toBe(
        "mn_addr_preprod1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sv7qz0p",
      );
    });

    it("derives the correct dust address", () => {
      const { dust } = deriveAddresses("preprod");
      expect(dust).toBe(
        "mn_dust_preprod1w0l54txthpu8q05j9j9ttk3j5dyu5766dc9zkz2s435vdglzwdr35mk3d8y",
      );
    });
  });
});

// ── KeyDeriver — Midnight address derivation (BIP-39 mnemonic) ───────────────
// Verifies that a known BIP-39 mnemonic produces the expected on-chain
// addresses on the `undeployed` (local) network.

describe("KeyDeriver — Midnight address derivation (mnemonic)", () => {
  const MNEMONIC =
    "credit pool deputy saddle drama govern plug cradle today skate wise like " +
    "bronze tackle normal split panel rabbit soldier join dragon dwarf foil humor";

  let zswapSeed: Uint8Array;
  let dustSeed: Uint8Array;
  let nightExternalSeed: Uint8Array;

  beforeAll(async () => {
    const deriver = new KeyDeriver({ mnemonic: MNEMONIC });
    ({ zswapSeed, dustSeed, nightExternalSeed } =
      await deriver.deriveMidnightSigningKeys());
  });

  /** Derive all three wallet addresses for a given network. */
  function deriveAddresses(networkId: string) {
    const zswapKeys = ZswapSecretKeys.fromSeed(zswapSeed);
    const cpk = ShieldedCoinPublicKey.fromHexString(zswapKeys.coinPublicKey);
    const epk = ShieldedEncryptionPublicKey.fromHexString(
      zswapKeys.encryptionPublicKey,
    );
    const shielded = ShieldedAddress.codec
      .encode(networkId, new ShieldedAddress(cpk, epk))
      .toString();

    const unshielded = createKeystore(nightExternalSeed, networkId)
      .getBech32Address()
      .toString();

    const dustKey = DustSecretKey.fromSeed(dustSeed);
    const dust = DustAddress.encodePublicKey(networkId, dustKey.publicKey);

    return { shielded, unshielded, dust };
  }

  describe("undeployed network", () => {
    it("derives the correct shielded (ZSwap) address", () => {
      const { shielded } = deriveAddresses("undeployed");
      expect(shielded).toBe(
        "mn_shield-addr_undeployed10trfltvgae9xaxpgtn9c0xzgzmnewv9gk4sclu6dt8ekhhrf769k0fy42dv28mqp92fegsvkckl8fjhkrdkfnknll0wtylar2hutn5g68cl0r",
      );
    });

    it("derives the correct unshielded address", () => {
      const { unshielded } = deriveAddresses("undeployed");
      expect(unshielded).toBe(
        "mn_addr_undeployed1ahmwmhjj8y343d5glctv2pnaypt2n843euygr85dt7hqvuzcx30scpjkas",
      );
    });

    it("derives the correct dust address", () => {
      const { dust } = deriveAddresses("undeployed");
      expect(dust).toBe(
        "mn_dust_undeployed1wva2ns5xumx9597drc3cr408hwyjgpaetwktuklq0fq38ydgxlryvh0aetl",
      );
    });
  });

  describe("preprod network", () => {
    it("derives the correct shielded (ZSwap) address", () => {
      const { shielded } = deriveAddresses("preprod");
      expect(shielded).toBe(
        "mn_shield-addr_preprod10trfltvgae9xaxpgtn9c0xzgzmnewv9gk4sclu6dt8ekhhrf769k0fy42dv28mqp92fegsvkckl8fjhkrdkfnknll0wtylar2hutn5grrtxnt",
      );
    });

    it("derives the correct unshielded address", () => {
      const { unshielded } = deriveAddresses("preprod");
      expect(unshielded).toBe(
        "mn_addr_preprod1ahmwmhjj8y343d5glctv2pnaypt2n843euygr85dt7hqvuzcx30sz6ggvp",
      );
    });

    it("derives the correct dust address", () => {
      const { dust } = deriveAddresses("preprod");
      expect(dust).toBe(
        "mn_dust_preprod1wva2ns5xumx9597drc3cr408hwyjgpaetwktuklq0fq38ydgxlryvphj3rl",
      );
    });
  });
});
