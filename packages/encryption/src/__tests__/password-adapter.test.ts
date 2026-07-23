import { describe, it, expect, vi } from "vitest";
import {
  PasswordEncryptionAdapter,
  generatePqsPassword,
  KDF_PRESETS,
  type KdfPreset,
} from "../PasswordEncryptionAdapter.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { mlkemGenerateKeypairFromSeed } from "@dstorage/crypto";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { EncryptionErrorCode } from "../errors.js";
import { CryptoErrorCode } from "@dstorage/crypto";

// Use the "v1-lite" preset params for all functional tests.
// N=65536 (64 MB) matches a real-world preset and exercises the full scrypt
// code path while keeping test runtime in the 200–400ms range per call.
const FAST_PARAMS = { N: 65536, r: 8, p: 1 };

const GOOD_PASSWORD = "Tr0ub4dor&3!XyZ8"; // 16 chars, mixed charset
const GOOD_SALT = "myapp:v1:alice@example.com";

// ---------------------------------------------------------------------------
// Determinism — same inputs always produce a key that can roundtrip
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same password + same string salt → identical encryption key (roundtrip)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const b = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const wrapped = await a.wrapDek(dek);
    const recovered = await b.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("same password + same Uint8Array salt → identical encryption key (roundtrip)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const salt = new TextEncoder().encode("raw-bytes-salt");
    const a = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt,
      params: FAST_PARAMS,
    });
    const b = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt,
      params: FAST_PARAMS,
    });
    const wrapped = await a.wrapDek(dek);
    const recovered = await b.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });
});

// ---------------------------------------------------------------------------
// Sensitivity — different inputs cannot cross-unwrap
// ---------------------------------------------------------------------------

describe("sensitivity", () => {
  it("same password + different string salt → cannot unwrap (different key)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: "myapp:alice",
      params: FAST_PARAMS,
    });
    const b = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: "myapp:bob",
      params: FAST_PARAMS,
    });
    const wrapped = await a.wrapDek(dek);
    await expect(b.unwrapDek(wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });

  it("different password + same salt → cannot unwrap (different key)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const b = new PasswordEncryptionAdapter({
      password: "An0ther$ecureP@ss!",
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const wrapped = await a.wrapDek(dek);
    await expect(b.unwrapDek(wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });
});

// ---------------------------------------------------------------------------
// Salt validation
// ---------------------------------------------------------------------------

describe("salt validation", () => {
  it("empty string salt → throws at construction", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: GOOD_PASSWORD,
        salt: "",
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_EMPTY_SALT,
      message: expect.stringContaining("salt must not be empty"),
    });
  });

  it("empty Uint8Array salt → throws at construction", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: GOOD_PASSWORD,
        salt: new Uint8Array(0),
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_EMPTY_SALT,
      message: expect.stringContaining("salt must not be empty"),
    });
  });
});

// ---------------------------------------------------------------------------
// Password validation
// ---------------------------------------------------------------------------

describe("password validation", () => {
  it("password shorter than minPasswordLength → throws", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "Sh0rt!",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_TOO_SHORT,
      message: expect.stringContaining("too short"),
    });
  });

  it("all-same-character password → throws regardless of length", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "aaaaaaaaaaaaaaa",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_TOO_FEW_DISTINCT,
      message: expect.stringContaining("too few distinct characters"),
    });
  });

  it("low entropy password (digits only, 12 chars) → throws", () => {
    // charset = digits (pool 10), 12 non-sequential chars → ~39.9 bits < 60
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "159753246801",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_ENTROPY_TOO_LOW,
      message: expect.stringContaining("entropy too low"),
    });
  });

  it("custom minPasswordLength: 8 → accepts 8-char password and can wrapDek", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const adapter = new PasswordEncryptionAdapter({
      password: "Pa$1Word",
      salt: GOOD_SALT,
      params: FAST_PARAMS,
      minPasswordLength: 8,
      minEntropyBits: 30,
    });
    const wrapped = await adapter.wrapDek(dek);
    expect(wrapped.algorithm).toBe("xchacha20poly1305-v1");
  });

  it("custom minEntropyBits: 30 → accepts low-entropy password and can wrapDek", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const adapter = new PasswordEncryptionAdapter({
      password: "159753246801",
      salt: GOOD_SALT,
      params: FAST_PARAMS,
      minEntropyBits: 30,
    });
    const wrapped = await adapter.wrapDek(dek);
    expect(wrapped.algorithm).toBe("xchacha20poly1305-v1");
  });

  it("high-entropy mixed password passes validation and can wrapDek", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const adapter = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const wrapped = await adapter.wrapDek(dek);
    expect(wrapped.algorithm).toBe("xchacha20poly1305-v1");
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

  it("additionalValidators: called on passing password; wrapDek succeeds", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const validator = vi.fn();
    const adapter = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
      additionalValidators: [validator],
    });
    await adapter.wrapDek(dek);
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

  it("preset 'v1-lite' → can wrapDek/unwrapDek", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      preset: "v1-lite",
    });
    const b = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      preset: "v1-lite",
    });
    const wrapped = await a.wrapDek(dek);
    const recovered = await b.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
  });

  it("custom params override preset N/r/p → deterministic encryption key", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: { N: 32768, r: 4, p: 1 },
    });
    const b = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: { N: 32768, r: 4, p: 1 },
    });
    const wrapped = await a.wrapDek(dek);
    expect(await b.unwrapDek(wrapped)).toEqual(dek);
  });

  it("same password + same salt + different custom N → cannot unwrap", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: { N: 32768, r: 8, p: 1 },
    });
    const b = new PasswordEncryptionAdapter({
      password: GOOD_PASSWORD,
      salt: GOOD_SALT,
      params: { N: 65536, r: 8, p: 1 },
    });
    const wrapped = await a.wrapDek(dek);
    await expect(b.unwrapDek(wrapped)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });

  it("unknown preset string → throws at construction", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: GOOD_PASSWORD,
        salt: GOOD_SALT,
        preset: "v99" as KdfPreset,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_UNKNOWN_PRESET,
      message: expect.stringContaining('unknown preset "v99"'),
    });
  });

  // ── minimum scrypt cost floor ────────────────────────────────────────────

  it("custom N below the 32768 floor → throws PASSWORD_SCRYPT_N_TOO_LOW", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: GOOD_PASSWORD,
        salt: GOOD_SALT,
        params: { N: 16384, r: 8, p: 1 },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_SCRYPT_N_TOO_LOW,
      message: expect.stringContaining("[dStorage]"),
    });
  });

  it("custom N that is not a power of two → throws PASSWORD_SCRYPT_N_NOT_POWER_OF_TWO", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: GOOD_PASSWORD,
        salt: GOOD_SALT,
        params: { N: 3000, r: 8, p: 1 },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_SCRYPT_N_NOT_POWER_OF_TWO,
      message: expect.stringContaining("[dStorage]"),
    });
  });

  it("custom N above the floor but not a power of two → still throws PASSWORD_SCRYPT_N_NOT_POWER_OF_TWO", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: GOOD_PASSWORD,
        salt: GOOD_SALT,
        params: { N: 100000, r: 8, p: 1 },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_SCRYPT_N_NOT_POWER_OF_TWO,
    });
  });

  it("custom N exactly at the 32768 floor → succeeds", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: GOOD_PASSWORD,
          salt: GOOD_SALT,
          params: { N: 32768, r: 8, p: 1 },
        }),
    ).not.toThrow();
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
  it("produces the same encryption key as the original provider (roundtrip)", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
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

    const wrapped = await original.wrapDek(dek);
    const recovered = await reconstructed.unwrapDek(wrapped);
    expect(recovered).toEqual(dek);
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
    let err: unknown;
    try {
      PasswordEncryptionAdapter.fromKdfParams({
        password: GOOD_PASSWORD,
        salt: GOOD_SALT,
        kdf: "argon2id" as "scrypt",
        N: 65536,
        r: 8,
        p: 1,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_UNSUPPORTED_KDF,
      message: expect.stringContaining('unsupported kdf "argon2id"'),
    });
  });

  it("still validates password entropy", () => {
    let err: unknown;
    try {
      PasswordEncryptionAdapter.fromKdfParams({
        password: "weak",
        salt: GOOD_SALT,
        kdf: "scrypt",
        N: 65536,
        r: 8,
        p: 1,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_TOO_SHORT,
      message: expect.stringContaining("too short"),
    });
  });

  it("rejects a stored N below the 32768 floor — guards against a downgraded/corrupted persisted value", () => {
    let err: unknown;
    try {
      PasswordEncryptionAdapter.fromKdfParams({
        password: GOOD_PASSWORD,
        salt: GOOD_SALT,
        kdf: "scrypt",
        N: 8192,
        r: 8,
        p: 1,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_SCRYPT_N_TOO_LOW,
    });
  });
});

// ---------------------------------------------------------------------------
// Weak-pattern rejection (structural checks)
// ---------------------------------------------------------------------------

describe("weak-pattern rejection", () => {
  it("keyboard-row walk 'qwertyuiop12' → throws", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "qwertyuiop12",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_KEYBOARD_WALK,
      message: expect.stringContaining("keyboard-row pattern"),
    });
  });

  it("keyboard-row walk 'asdfghjkl123' → throws", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "asdfghjkl123",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_KEYBOARD_WALK,
      message: expect.stringContaining("keyboard-row pattern"),
    });
  });

  it("keyboard-row walk reversed 'poiuytrewq1!' → throws", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "poiuytrewq1!",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_KEYBOARD_WALK,
      message: expect.stringContaining("keyboard-row pattern"),
    });
  });

  it("sequential alpha run 'abcdefghij12' → throws", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "abcdefghij12",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_SEQUENTIAL_RUN,
      message: expect.stringContaining("sequential character run"),
    });
  });

  it("sequential numeric run '123456789012' → throws", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "123456789012",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_SEQUENTIAL_RUN,
      message: expect.stringContaining("sequential character run"),
    });
  });

  it("near-identical chars 'aaaaaaaaaaaab' → throws (too few distinct)", () => {
    let err: unknown;
    try {
      new PasswordEncryptionAdapter({
        password: "aaaaaaaaaaaab",
        salt: GOOD_SALT,
        params: FAST_PARAMS,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: EncryptionErrorCode.PASSWORD_TOO_FEW_DISTINCT,
      message: expect.stringContaining("too few distinct characters"),
    });
  });

  it("long passphrase 'correcthorsebatterystaple' → construction succeeds", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "correcthorsebatterystaple",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).not.toThrow();
  });

  it("strong mixed password passes all structural checks", () => {
    expect(
      () =>
        new PasswordEncryptionAdapter({
          password: "Str0ng-PaSSw0rd!",
          salt: GOOD_SALT,
          params: FAST_PARAMS,
        }),
    ).not.toThrow();
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
    const keypairAdapter =
      await adapter.intoKeypairEncryptionAdapter("test-context");
    expect(keypairAdapter).toBeDefined();
    expect(keypairAdapter.name).toMatch(/^mlkem/);
  });

  it("ML-KEM seed is domain-separated from the raw scrypt output", async () => {
    const pw = generatePqsPassword();

    // Compute the raw scrypt output independently (without going through the adapter).
    const passwordBytes = new TextEncoder().encode(pw);
    const saltBytes = new TextEncoder().encode(GOOD_SALT);
    const rawSeed = scrypt(passwordBytes, saltBytes, {
      ...FAST_PARAMS,
      dkLen: 64,
    });

    // Keypair derived directly from the raw scrypt output (no HKDF — old, unsafe path).
    const { pk: pkRaw } = mlkemGenerateKeypairFromSeed(rawSeed);

    // Keypair produced by intoKeypairEncryptionAdapter (must use HKDF domain separation).
    const adapter = new PasswordEncryptionAdapter({
      password: pw,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const keypairAdapter =
      await adapter.intoKeypairEncryptionAdapter("test-context");
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));

    // Trying to unwrap with the raw-seed keypair MUST FAIL — the two paths are independent.
    const { KeypairEncryptionAdapter } =
      await import("../KeypairEncryptionAdapter.js");
    const rawAdapter = KeypairEncryptionAdapter.fromPublicKey(
      pkRaw,
      "test-context",
    );
    const wrappedRaw = await rawAdapter.wrapDek(dek);
    await expect(keypairAdapter.unwrapDek(wrappedRaw)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });

  it("ML-KEM seed is derived via HKDF with info='dstorage:mlkem-seed:v1'", async () => {
    const pw = generatePqsPassword();

    // Compute expected ML-KEM seed independently: scrypt → HKDF(sha256, salt=32zeros, info).
    const passwordBytes = new TextEncoder().encode(pw);
    const saltBytes = new TextEncoder().encode(GOOD_SALT);
    const rawSeed = scrypt(passwordBytes, saltBytes, {
      ...FAST_PARAMS,
      dkLen: 64,
    });
    const expectedMlkemSeed = hkdf(
      sha256,
      rawSeed,
      undefined,
      new TextEncoder().encode("dstorage:mlkem-seed:v1"),
      64,
    );
    const { pk: pkExpected, sk: skExpected } =
      mlkemGenerateKeypairFromSeed(expectedMlkemSeed);

    // Verify that intoKeypairEncryptionAdapter() uses the same derivation.
    const adapter = new PasswordEncryptionAdapter({
      password: pw,
      salt: GOOD_SALT,
      params: FAST_PARAMS,
    });
    const keypairAdapter =
      await adapter.intoKeypairEncryptionAdapter("test-context");
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await keypairAdapter.wrapDek(dek);

    const { KeypairEncryptionAdapter } =
      await import("../KeypairEncryptionAdapter.js");
    const expectedAdapter = KeypairEncryptionAdapter.fromKeypair(
      pkExpected,
      skExpected,
      "test-context",
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
      }).intoKeypairEncryptionAdapter("test-context");
    const [a, b] = await Promise.all([make(), make()]);
    // Wrap a fresh DEK with adapter A, unwrap with adapter B — must succeed.
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await a.wrapDek(dek);
    const unwrapped = await b.unwrapDek(wrapped);
    expect(Array.from(unwrapped)).toEqual(Array.from(dek));
  });
});
