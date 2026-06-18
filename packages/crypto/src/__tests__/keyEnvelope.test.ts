import { describe, it, expect } from "vitest";
import {
  generateDek,
  deriveKek,
  wrapKey,
  unwrapKey,
  deriveOwnerSecret,
  buildKeyEnvelope,
  serializeKeyEnvelope,
  parseKeyEnvelope,
  findWrapper,
  type KeyWrapper,
} from "../keyEnvelope.js";
import { CryptoErrorCode } from "../errors.js";

// Helper: create a minimal symmetric KeyWrapper for tests.
function symWrapper(wrappedDek: string, wrapKeyName: string): KeyWrapper {
  return {
    wrapKeyName,
    algorithm: "xchacha20poly1305-v1",
    kekDerivation: "hkdf-sha256-v1",
    wrappedDek,
  };
}

// ── generateDek ───────────────────────────────────────────────────────────────

describe("generateDek", () => {
  it("produces a 32-byte Uint8Array", () => {
    const dek = generateDek();
    expect(dek).toBeInstanceOf(Uint8Array);
    expect(dek.byteLength).toBe(32);
  });

  it("two consecutive calls return different values", () => {
    const a = generateDek();
    const b = generateDek();
    expect(a).not.toEqual(b);
  });
});

// Helper: import raw bytes as a non-extractable HKDF CryptoKey.
function importSeed(bytes: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveBits",
  ]);
}

// ── deriveKek ─────────────────────────────────────────────────────────────────

describe("deriveKek", () => {
  it("returns a 32-byte Uint8Array", async () => {
    const key = await importSeed(new Uint8Array(32).fill(0xab));
    const kek = await deriveKek(key);
    expect(kek).toBeInstanceOf(Uint8Array);
    expect(kek.byteLength).toBe(32);
  });

  it("same seed and context → same KEK (deterministic)", async () => {
    const key1 = await importSeed(new Uint8Array(32).fill(0x42));
    const key2 = await importSeed(new Uint8Array(32).fill(0x42));
    const kek1 = await deriveKek(key1, "0xAlice");
    const kek2 = await deriveKek(key2, "0xAlice");
    expect(kek1).toEqual(kek2);
  });

  it("same seed with different context → different KEK", async () => {
    const key1 = await importSeed(new Uint8Array(32).fill(0x42));
    const key2 = await importSeed(new Uint8Array(32).fill(0x42));
    const kekAlice = await deriveKek(key1, "0xAlice");
    const kekBob = await deriveKek(key2, "0xBob");
    expect(kekAlice).not.toEqual(kekBob);
  });

  it("with context vs without context → different KEK", async () => {
    const key1 = await importSeed(new Uint8Array(32).fill(0x42));
    const key2 = await importSeed(new Uint8Array(32).fill(0x42));
    const kekWithout = await deriveKek(key1);
    const kekWith = await deriveKek(key2, "ctx");
    expect(kekWithout).not.toEqual(kekWith);
  });
});

// ── wrapKey / unwrapKey ───────────────────────────────────────────────────────

describe("wrapKey / unwrapKey", () => {
  it("round-trip: unwrapKey(wrapKey(dek, kek), kek) returns original DEK", async () => {
    const dek = generateDek();
    const kek = new Uint8Array(32).fill(0x11);
    const wrapped = await wrapKey(dek, kek);
    const recovered = await unwrapKey(wrapped, kek);
    expect(recovered).toEqual(dek);
  });

  it("wrapKey returns a base64url string (96 chars)", async () => {
    const dek = generateDek();
    const kek = new Uint8Array(32).fill(0x22);
    const wrapped = await wrapKey(dek, kek);
    expect(typeof wrapped).toBe("string");
    expect(wrapped.length).toBe(96);
  });

  it("same dek + kek → different wrapped output each time (fresh nonce)", async () => {
    const dek = generateDek();
    const kek = new Uint8Array(32).fill(0x33);
    const w1 = await wrapKey(dek, kek);
    const w2 = await wrapKey(dek, kek);
    expect(w1).not.toBe(w2);
  });

  it("wrong KEK causes unwrapKey to throw", async () => {
    const dek = generateDek();
    const kek = new Uint8Array(32).fill(0x44);
    const wrongKek = new Uint8Array(32).fill(0x55);
    const wrapped = await wrapKey(dek, kek);
    await expect(unwrapKey(wrapped, wrongKek)).rejects.toMatchObject({
      code: CryptoErrorCode.XCHACHA_STORAGE_ID_MALFORMED,
    });
  });
});

// ── deriveOwnerSecret ─────────────────────────────────────────────────────────

describe("deriveOwnerSecret", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("returns a 32-byte Uint8Array", async () => {
    const dek = new Uint8Array(32).fill(0x01);
    const storageId = enc("arweave-tx-id-abc123");
    const secret = await deriveOwnerSecret(dek, storageId);
    expect(secret).toBeInstanceOf(Uint8Array);
    expect(secret.byteLength).toBe(32);
  });

  it("same DEK + same storageId → same ownerSecret (deterministic)", async () => {
    const dek = new Uint8Array(32).fill(0x02);
    const storageId = enc("tx-id-xyz");
    const s1 = await deriveOwnerSecret(dek, storageId);
    const s2 = await deriveOwnerSecret(dek, storageId);
    expect(s1).toEqual(s2);
  });

  it("different DEK → different ownerSecret", async () => {
    const dek1 = new Uint8Array(32).fill(0x03);
    const dek2 = new Uint8Array(32).fill(0x04);
    const storageId = enc("same-tx-id");
    const s1 = await deriveOwnerSecret(dek1, storageId);
    const s2 = await deriveOwnerSecret(dek2, storageId);
    expect(s1).not.toEqual(s2);
  });

  it("different storageId → different ownerSecret", async () => {
    const dek = new Uint8Array(32).fill(0x05);
    const s1 = await deriveOwnerSecret(dek, enc("tx-id-aaa"));
    const s2 = await deriveOwnerSecret(dek, enc("tx-id-bbb"));
    expect(s1).not.toEqual(s2);
  });

  it("ownerSecret is not equal to the DEK itself", async () => {
    const dek = new Uint8Array(32).fill(0x06);
    const secret = await deriveOwnerSecret(dek, enc("some-tx-id"));
    expect(secret).not.toEqual(dek);
  });
});

// ── buildKeyEnvelope ──────────────────────────────────────────────────────────

describe("buildKeyEnvelope", () => {
  it("returns an envelope with v=1", () => {
    const envelope = buildKeyEnvelope([symWrapper("a".repeat(96), "password")]);
    expect(envelope.v).toBe(1);
  });

  it("each wrapper has the expected fields", () => {
    const envelope = buildKeyEnvelope([symWrapper("a".repeat(96), "password")]);
    const w = envelope.wrappers[0];
    expect(w.wrapKeyName).toBe("password");
    expect(w.algorithm).toBe("xchacha20poly1305-v1");
    expect(w.kekDerivation).toBe("hkdf-sha256-v1");
    expect(w.wrappedDek).toBe("a".repeat(96));
  });

  it("two wrappers → wrappers array length 2", () => {
    const envelope = buildKeyEnvelope([
      symWrapper("a".repeat(96), "password"),
      symWrapper("b".repeat(96), "mnemonic"),
    ]);
    expect(envelope.wrappers).toHaveLength(2);
  });

  it("empty wrappers array throws", () => {
    let err: unknown;
    try {
      buildKeyEnvelope([]);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: CryptoErrorCode.ENVELOPE_EMPTY_WRAPPERS,
    });
  });
});

// ── serializeKeyEnvelope / parseKeyEnvelope ───────────────────────────────────

describe("serializeKeyEnvelope / parseKeyEnvelope", () => {
  it("parse(serialize(envelope)) round-trips correctly", () => {
    const original = buildKeyEnvelope([symWrapper("z".repeat(96), "test-key")]);
    const serialized = serializeKeyEnvelope(original);
    const parsed = parseKeyEnvelope(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.v).toBe(1);
    expect(parsed!.wrappers[0].wrapKeyName).toBe("test-key");
    expect(parsed!.wrappers[0].wrappedDek).toBe("z".repeat(96));
  });

  it("serialized form is a valid JSON string", () => {
    const envelope = buildKeyEnvelope([symWrapper("c".repeat(96), "pw")]);
    const json = serializeKeyEnvelope(envelope);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("parseKeyEnvelope", () => {
  it("returns null for empty string", () => {
    expect(parseKeyEnvelope("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseKeyEnvelope("{not valid json")).toBeNull();
  });

  it("returns null when v is not 1", () => {
    expect(
      parseKeyEnvelope(JSON.stringify({ v: 2, wrappers: [{}] })),
    ).toBeNull();
  });

  it("returns null when wrappers field is missing", () => {
    expect(parseKeyEnvelope(JSON.stringify({ v: 1 }))).toBeNull();
  });

  it("returns null when wrappers array is empty", () => {
    expect(parseKeyEnvelope(JSON.stringify({ v: 1, wrappers: [] }))).toBeNull();
  });

  it("returns the envelope for a valid v1 JSON with non-empty wrappers", () => {
    const json = JSON.stringify({
      v: 1,
      wrappers: [
        {
          wrapKeyName: "pw",
          algorithm: "xchacha20poly1305-v1",
          kekDerivation: "hkdf-sha256-v1",
          wrappedDek: "d".repeat(96),
        },
      ],
    });
    const result = parseKeyEnvelope(json);
    expect(result).not.toBeNull();
    expect(result!.wrappers).toHaveLength(1);
  });
});

// ── findWrapper ───────────────────────────────────────────────────────────────

describe("findWrapper", () => {
  it("returns the wrapper matching the given wrapKeyName", () => {
    const envelope = buildKeyEnvelope([
      symWrapper("a".repeat(96), "password"),
      symWrapper("b".repeat(96), "mnemonic"),
    ]);
    const found = findWrapper(envelope, "mnemonic");
    expect(found).not.toBeNull();
    expect(found!.wrapKeyName).toBe("mnemonic");
    expect(found!.wrappedDek).toBe("b".repeat(96));
  });

  it("returns null when the name is not found", () => {
    const envelope = buildKeyEnvelope([symWrapper("a".repeat(96), "password")]);
    expect(findWrapper(envelope, "biometric")).toBeNull();
  });
});
