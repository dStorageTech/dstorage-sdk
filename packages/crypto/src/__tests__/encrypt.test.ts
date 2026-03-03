import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  serializePayload,
  deserializePayload,
} from "../encrypt.js";
import { deriveKeyFromSignature } from "../keys.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeKey(
  sig = "abcd".repeat(16),
  salt = "test",
): Promise<CryptoKey> {
  return deriveKeyFromSignature(sig, salt);
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── encrypt ───────────────────────────────────────────────────────────────────

describe("encrypt", () => {
  it("returns an EncryptedPayload with ciphertext and iv", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("hello"));
    expect(payload).toHaveProperty("ciphertext");
    expect(payload).toHaveProperty("iv");
    expect(typeof payload.ciphertext).toBe("string");
    expect(typeof payload.iv).toBe("string");
  });

  it("ciphertext and iv are non-empty base64 strings", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("world"));
    expect(payload.ciphertext.length).toBeGreaterThan(0);
    expect(payload.iv.length).toBeGreaterThan(0);
    // Base64 characters only
    expect(payload.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(payload.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("generates a unique IV on every call (randomness)", async () => {
    const key = await makeKey();
    const data = bytes("same content");
    const p1 = await encrypt(key, data);
    const p2 = await encrypt(key, data);
    // Both IVs are 12-byte → 16 base64 chars; they must be different
    expect(p1.iv).not.toBe(p2.iv);
    // Ciphertexts also differ due to different IVs
    expect(p1.ciphertext).not.toBe(p2.ciphertext);
  });

  it("encrypts an empty Uint8Array without error", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, new Uint8Array(0));
    expect(payload.ciphertext).toBeDefined();
    // AES-GCM on empty plaintext produces a 16-byte authentication tag
    expect(payload.ciphertext.length).toBeGreaterThan(0);
  });

  it("encrypts large data (100 KB)", async () => {
    const key = await makeKey();
    const big = new Uint8Array(100 * 1024);
    // Fill deterministically (getRandomValues has a 65536-byte limit)
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const payload = await encrypt(key, big);
    expect(payload.ciphertext.length).toBeGreaterThan(0);
  });

  it("ciphertext is longer than plaintext (includes AES-GCM auth tag)", async () => {
    const key = await makeKey();
    const plaintext = bytes("short text");
    const payload = await encrypt(key, plaintext);
    const cipherLen = atob(payload.ciphertext).length;
    // AES-GCM adds a 16-byte authentication tag
    expect(cipherLen).toBeGreaterThan(plaintext.length);
  });
});

// ── decrypt ───────────────────────────────────────────────────────────────────

describe("decrypt", () => {
  it("round-trips: encrypt then decrypt recovers original bytes", async () => {
    const key = await makeKey();
    const original = bytes("private health record data");
    const payload = await encrypt(key, original);
    const recovered = await decrypt(key, payload);
    expect(recovered).toEqual(original);
  });

  it("decrypts empty plaintext correctly", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, new Uint8Array(0));
    const recovered = await decrypt(key, payload);
    expect(recovered).toEqual(new Uint8Array(0));
  });

  it("decrypts large data correctly (100 KB round-trip)", async () => {
    const key = await makeKey();
    const big = new Uint8Array(100 * 1024);
    // Fill deterministically (getRandomValues has a 65536-byte limit)
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const payload = await encrypt(key, big);
    const recovered = await decrypt(key, payload);
    expect(recovered).toEqual(big);
  });

  it("decrypts all byte values 0–255 correctly (binary data)", async () => {
    const key = await makeKey();
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;
    const payload = await encrypt(key, allBytes);
    const recovered = await decrypt(key, payload);
    expect(recovered).toEqual(allBytes);
  });

  it("returns Uint8Array", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("test"));
    const result = await decrypt(key, payload);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("rejects when decrypting with a different key", async () => {
    const keyA = await makeKey("aaaa".repeat(16), "salt-a");
    const keyB = await makeKey("bbbb".repeat(16), "salt-b");
    const payload = await encrypt(keyA, bytes("secret"));
    await expect(decrypt(keyB, payload)).rejects.toBeDefined();
  });

  it("rejects when ciphertext is tampered", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("important"));
    // Flip the last character of the base64 ciphertext
    const tampered = {
      ciphertext:
        payload.ciphertext.slice(0, -1) +
        (payload.ciphertext.endsWith("A") ? "B" : "A"),
      iv: payload.iv,
    };
    await expect(decrypt(key, tampered)).rejects.toBeDefined();
  });

  it("rejects when IV is tampered", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("important"));
    const tamperedIv = btoa(String.fromCharCode(...new Uint8Array(12).fill(0)));
    await expect(
      decrypt(key, { ciphertext: payload.ciphertext, iv: tamperedIv }),
    ).rejects.toBeDefined();
  });
});

// ── serializePayload / deserializePayload ─────────────────────────────────────

describe("serializePayload", () => {
  it("returns a valid JSON string", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("test"));
    const serialized = serializePayload(payload);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it("serialized JSON contains ciphertext and iv fields", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("test"));
    const serialized = serializePayload(payload);
    const parsed = JSON.parse(serialized);
    expect(parsed).toHaveProperty("ciphertext", payload.ciphertext);
    expect(parsed).toHaveProperty("iv", payload.iv);
  });

  it("round-trips through deserializePayload", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("round-trip"));
    const roundTripped = deserializePayload(serializePayload(payload));
    expect(roundTripped).toEqual(payload);
  });
});

describe("deserializePayload", () => {
  it("parses a valid serialized payload", async () => {
    const key = await makeKey();
    const payload = await encrypt(key, bytes("data"));
    const raw = serializePayload(payload);
    const result = deserializePayload(raw);
    expect(result.ciphertext).toBe(payload.ciphertext);
    expect(result.iv).toBe(payload.iv);
  });

  it("throws for missing ciphertext field", () => {
    const raw = JSON.stringify({ iv: "AAAAAAAAAAAAAAAA" });
    expect(() => deserializePayload(raw)).toThrow(
      "[dStorage/crypto] Invalid payload format.",
    );
  });

  it("throws for missing iv field", () => {
    const raw = JSON.stringify({ ciphertext: "AAAA" });
    expect(() => deserializePayload(raw)).toThrow(
      "[dStorage/crypto] Invalid payload format.",
    );
  });

  it("throws for null JSON value", () => {
    expect(() => deserializePayload("null")).toThrow(
      "[dStorage/crypto] Invalid payload format.",
    );
  });

  it("throws for a JSON array (not an object)", () => {
    expect(() => deserializePayload("[]")).toThrow(
      "[dStorage/crypto] Invalid payload format.",
    );
  });

  it("throws for invalid JSON (SyntaxError)", () => {
    expect(() => deserializePayload("not json")).toThrow(SyntaxError);
  });

  it("accepts payloads with extra unknown fields", () => {
    const raw = JSON.stringify({
      ciphertext: "AAAA",
      iv: "BBBB",
      extra: "ignored",
    });
    const result = deserializePayload(raw);
    expect(result.ciphertext).toBe("AAAA");
    expect(result.iv).toBe("BBBB");
  });

  it("full serialize → deserialize → decrypt round-trip", async () => {
    const key = await makeKey();
    const original = bytes("full round-trip with deserialization");
    const payload = await encrypt(key, original);
    const serialized = serializePayload(payload);
    const deserialized = deserializePayload(serialized);
    const recovered = await decrypt(key, deserialized);
    expect(new TextDecoder().decode(recovered)).toBe(
      "full round-trip with deserialization",
    );
  });
});
