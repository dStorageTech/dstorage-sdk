import { describe, it, expect, vi } from "vitest";
import {
  PasswordEncryptionAdapter,
  generatePqsPassword,
  KDF_PRESETS,
  type KdfPreset,
} from "../PasswordEncryptionAdapter.js";
import { mlkemGenerateKeypairFromSeed } from "@dstorage/crypto";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

// Use the "v1-lite" preset params for all functional tests.
// N=65536 (64 MB) matches a real-world preset and exercises the full scrypt
// code path while keeping test runtime in the 200–400ms range per call.
const FAST_PARAMS = { N: 65536, r: 8, p: 1 };

const GOOD_PASSWORD = "Tr0ub4dor&3!XyZ8"; // 16 chars, mixed charset
const GOOD_SALT = "myapp:v1:alice@example.com";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same password + same string salt → identical seed", async () => {
    const a = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    }).getSeed();
    const b = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    }).getSeed();
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("same password + same Uint8Array salt → identical seed", async () => {
    const salt = new TextEncoder().encode("raw-bytes-salt");
    const a = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt,
      params: FAST_PARAMS,
    }).getSeed();
    const b = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt,
      params: FAST_PARAMS,
    }).getSeed();
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });
});

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

describe("sensitivity", () => {
  it("same password + different string salt → different seed", async () => {
    const a = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: "myapp:alice",
      params: FAST_PARAMS,
    }).getSeed();
    const b = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: "myapp:bob",
      params: FAST_PARAMS,
    }).getSeed();
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("different password + same salt → different seed", async () => {
    const a = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    }).getSeed();
    const b = await new PasswordEncryptionAdapter({
      password: "An0ther$ecureP@ss!",
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    }).getSeed();
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

describe("output format", () => {
  it("getSeed() returns a 64-byte Uint8Array", async () => {
    const seed = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    }).getSeed();
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.byteLength).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Salt validation
// ---------------------------------------------------------------------------

describe("salt validation", () => {
  it("empty string salt → throws at construction", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: GOOD_PASSWORD,
          salt: "",
          params: FAST_PARAMS,
        }),
    ).toThrow("salt must not be empty");
  });

  it("empty Uint8Array salt → throws at construction", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: GOOD_PASSWORD,
          salt: new Uint8Array(0),
          params: FAST_PARAMS,
        }),
    ).toThrow("salt must not be empty");
  });
});

// ---------------------------------------------------------------------------
// Password validation
// ---------------------------------------------------------------------------

describe("password validation", () => {
  it("password shorter than minPasswordLength → throws", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "Sh0rt!",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("too short");
  });

  it("all-same-character password → throws regardless of length", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "aaaaaaaaaaaaaaa",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("too few distinct characters");
  });

  it("low entropy password (digits only, 12 chars) → throws", () => {
    // charset = digits (pool 10), 12 non-sequential chars → ~39.9 bits < 60
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "159753246801",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("entropy too low");
  });

  it("custom minPasswordLength: 8 → accepts 8-char password", async () => {
    // "Pa$1Word" — 8 chars, mixed charset → should pass with minPasswordLength:8
    const seed = await new PasswordEncryptionAdapter({
      password: "Pa$1Word",
      salt: GOOD_SALT,
      params: FAST_PARAMS,
      minPasswordLength: 8,
      minEntropyBits: 30, // lower bar too so it doesn't fail entropy
    }).getSeed();
    expect(seed.byteLength).toBe(64);
  });

  it("custom minEntropyBits: 30 → accepts low-entropy password", async () => {
    // non-sequential digits only, 12 chars → ~39.9 bits, accepted when threshold is 30
    const seed = await new PasswordEncryptionAdapter({
      password: "159753246801",
      salt: GOOD_SALT,
      params: FAST_PARAMS,
      minEntropyBits: 30,
    }).getSeed();
    expect(seed.byteLength).toBe(64);
  });

  it("high-entropy mixed password passes validation", async () => {
    const seed = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    }).getSeed();
    expect(seed.byteLength).toBe(64);
  });

  it("additionalValidators: called and can throw", () => {
    const validator = vi.fn().mockImplementation((pw: string) => {
      if (pw.toLowerCase().includes("password")) {
        throw new Error("Common word detected.");
      }
    });
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "Mypassword!XyZ8",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
          additionalValidators: [validator],
        }),
    ).toThrow("Common word detected.");
    expect(validator).toHaveBeenCalledWith("Mypassword!XyZ8");
  });

  it("additionalValidators: called on passing password", async () => {
    const validator = vi.fn();
    await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
      additionalValidators: [validator],
    }).getSeed();
    expect(validator).toHaveBeenCalledWith(GOOD_PASSWORD);
  });
});

// ---------------------------------------------------------------------------
// KDF presets and params
// ---------------------------------------------------------------------------

describe("KDF presets", () => {
  it("preset 'v1' and 'v1-lite' have distinct N values", () => {
    expect(KDF_PRESETS["v1"].N).toBe(131072);
    expect(KDF_PRESETS["v1-lite"].N).toBe(65536);
  });

  it("preset 'v1-lite' → same password + same salt produces a 64-byte seed", async () => {
    const seed = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      preset: "v1-lite",
    }).getSeed();
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.byteLength).toBe(64);
  });

  it("custom params override preset N/r/p → deterministic output", async () => {
    const a = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: { N: 2048, r: 4, p: 1 },
    }).getSeed();
    const b = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: { N: 2048, r: 4, p: 1 },
    }).getSeed();
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("same password + same salt + different custom N → different seed", async () => {
    const a = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: { N: 1024, r: 8, p: 1 },
    }).getSeed();
    const b = await new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: { N: 2048, r: 8, p: 1 },
    }).getSeed();
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("unknown preset string → throws at construction", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: GOOD_PASSWORD,
          salt: GOOD_SALT,
          preset: "v99" as KdfPreset,
        }),
    ).toThrow('unknown preset "v99"');
  });
});

// ---------------------------------------------------------------------------
// getKdfParams — storable, language-agnostic metadata
// ---------------------------------------------------------------------------

describe("getKdfParams", () => {
  it("returns kdf: 'scrypt' with resolved N/r/p for default preset", () => {
    const provider = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    expect(provider.getKdfParams()).toEqual({
      kdf: "scrypt",
      N: FAST_PARAMS.N,
      r: FAST_PARAMS.r,
      p: FAST_PARAMS.p,
    });
  });

  it("reflects the resolved preset values, not the preset name", () => {
    const provider = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      preset: "v1-lite",
    });
    const params = provider.getKdfParams();
    expect(params.kdf).toBe("scrypt");
    expect(params.N).toBe(KDF_PRESETS["v1-lite"].N);
    expect(params.r).toBe(KDF_PRESETS["v1-lite"].r);
    expect(params.p).toBe(KDF_PRESETS["v1-lite"].p);
  });

  it("returned object does not contain preset name", () => {
    const provider = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      preset: "v1-lite",
    });
    expect(provider.getKdfParams()).not.toHaveProperty("preset");
  });
});

// ---------------------------------------------------------------------------
// fromKdfParams — reconstruct from stored metadata
// ---------------------------------------------------------------------------

describe("fromKdfParams", () => {
  it("produces the same seed as the original provider", async () => {
    const original = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const storedParams = original.getKdfParams();

    const reconstructed = PasswordEncryptionAdapter.fromKdfParams({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      ...storedParams,
    });

    const seedA = await original.getSeed();
    const seedB = await reconstructed.getSeed();
    expect(bytesToHex(seedA)).toBe(bytesToHex(seedB));
  });

  it("getKdfParams() round-trips through fromKdfParams", () => {
    const original = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const reconstructed = PasswordEncryptionAdapter.fromKdfParams({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      ...original.getKdfParams(),
    });
    expect(reconstructed.getKdfParams()).toEqual(original.getKdfParams());
  });

  it("unsupported kdf value → throws", () => {
    expect(() =>
      PasswordEncryptionAdapter.fromKdfParams({
        password: GOOD_PASSWORD,
        salt: GOOD_SALT,
        kdf: "argon2id" as "scrypt",
        N: 65536,
        r: 8,
        p: 1,
      }),
    ).toThrow('unsupported kdf "argon2id"');
  });

  it("still validates password entropy", () => {
    expect(() =>
      PasswordEncryptionAdapter.fromKdfParams({
        password: "weak",
        salt: GOOD_SALT,
        kdf: "scrypt",
        N: 65536,
        r: 8,
        p: 1,
      }),
    ).toThrow("too short");
  });
});

// ---------------------------------------------------------------------------
// Weak-pattern rejection (D3 structural checks)
// ---------------------------------------------------------------------------

describe("weak-pattern rejection", () => {
  it("keyboard-row walk 'qwertyuiop12' → throws", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "qwertyuiop12",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("keyboard-row pattern");
  });

  it("keyboard-row walk 'asdfghjkl123' → throws", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "asdfghjkl123",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("keyboard-row pattern");
  });

  it("keyboard-row walk reversed 'poiuytrewq1!' → throws", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "poiuytrewq1!",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("keyboard-row pattern");
  });

  it("sequential alpha run 'abcdefghij12' → throws", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "abcdefghij12",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("sequential character run");
  });

  it("sequential numeric run '123456789012' → throws", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "123456789012",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("sequential character run");
  });

  it("near-identical chars 'aaaaaaaaaaaab' → throws (too few distinct)", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "aaaaaaaaaaaab",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).toThrow("too few distinct characters");
  });

  it("long passphrase 'correcthorsebatterystaple' → passes", async () => {
    const seed = await new PasswordEncryptionAdapter({
      password: "correcthorsebatterystaple",
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    }).getSeed();
    expect(seed.byteLength).toBe(64);
  });

  it("strong mixed password passes all structural checks", async () => {
    const seed = await new PasswordEncryptionAdapter({
      password: "Str0ng-PaSSw0rd!",
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    }).getSeed();
    expect(seed.byteLength).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// generatePqsPassword
// ---------------------------------------------------------------------------

describe("generatePqsPassword", () => {
  it("returns a 43-character base64url string", () => {
    const pw = generatePqsPassword();
    expect(pw).toHaveLength(43);
    expect(pw).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("two calls return different passwords", () => {
    expect(generatePqsPassword()).not.toBe(generatePqsPassword());
  });

  it("result passes PasswordEncryptionAdapter construction", () => {
    const pw = generatePqsPassword();
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: pw,
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).not.toThrow();
  });

  it("result + intoKeypairEncryptionAdapter() produces a keypair adapter", async () => {
    const pw = generatePqsPassword();
    const adapter = new PasswordEncryptionAdapter({
      password: pw,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const keypairAdapter = await adapter.intoKeypairEncryptionAdapter();
    expect(keypairAdapter).toBeDefined();
    expect(keypairAdapter.name).toMatch(/^mlkem/);
  });

  it("ML-KEM seed is domain-separated from the raw scrypt output (not passed directly)", async () => {
    // Before the fix: mlkemGenerateKeypairFromSeed receives the raw seed64 directly,
    // so the keypair derived from the raw seed matches. After the fix, HKDF with
    // info="dstorage:mlkem-seed:v1" is applied first — the raw seed produces a
    // different keypair, so this test fails before the fix.
    const pw = generatePqsPassword();
    const adapter = new PasswordEncryptionAdapter({
      password: pw,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const rawSeed = await adapter.getSeed();

    // Keypair derived directly from the raw seed (old, unsafe behaviour).
    const { pk: pkRaw } = mlkemGenerateKeypairFromSeed(rawSeed);

    // Keypair produced by intoKeypairEncryptionAdapter (must use HKDF domain separation).
    const keypairAdapter = await adapter.intoKeypairEncryptionAdapter();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await keypairAdapter.wrapDek(dek);

    // Trying to unwrap with the raw-seed keypair must FAIL — confirming the two
    // paths are independent.
    const { KeypairEncryptionAdapter } =
      await import("../KeypairEncryptionAdapter.js");
    const rawAdapter = KeypairEncryptionAdapter.fromPublicKey(pkRaw);
    // wrapDek with raw public key should produce a ciphertext that the domain-separated
    // adapter cannot unwrap — i.e. the public keys are different.
    const wrappedRaw = await rawAdapter.wrapDek(dek);
    await expect(keypairAdapter.unwrapDek(wrappedRaw)).rejects.toThrow();
  });

  it("ML-KEM seed is derived via HKDF with info='dstorage:mlkem-seed:v1'", async () => {
    const pw = generatePqsPassword();
    const adapter = new PasswordEncryptionAdapter({
      password: pw,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const rawSeed = await adapter.getSeed();

    // Expected: HKDF-derived seed with the domain-separation label.
    const expectedMlkemSeed = hkdf(
      sha256,
      rawSeed,
      undefined,
      new TextEncoder().encode("dstorage:mlkem-seed:v1"),
      64,
    );
    const { pk: pkExpected } = mlkemGenerateKeypairFromSeed(expectedMlkemSeed);

    // Actual: wrap a DEK with the adapter's keypair, then verify it can be unwrapped
    // with the keypair derived from the expected HKDF seed.
    const keypairAdapter = await adapter.intoKeypairEncryptionAdapter();
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await keypairAdapter.wrapDek(dek);

    const { KeypairEncryptionAdapter } =
      await import("../KeypairEncryptionAdapter.js");
    const { sk: skExpected } = mlkemGenerateKeypairFromSeed(expectedMlkemSeed);
    const expectedAdapter = KeypairEncryptionAdapter.fromKeypair(
      pkExpected,
      skExpected,
    );
    const unwrapped = await expectedAdapter.unwrapDek(wrapped);
    expect(Array.from(unwrapped)).toEqual(Array.from(dek));
  });

  it("same password + same salt → same keypair adapter (deterministic)", async () => {
    const pw = generatePqsPassword();
    const make = () =>
      new PasswordEncryptionAdapter({
        password: pw,
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      }).intoKeypairEncryptionAdapter();
    const [a, b] = await Promise.all([make(), make()]);
    // Wrap a fresh DEK with adapter A, unwrap with adapter B — must succeed.
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await a.wrapDek(dek);
    const unwrapped = await b.unwrapDek(wrapped);
    expect(Array.from(unwrapped)).toEqual(Array.from(dek));
  });
});
