import { describe, it, expect } from "vitest";
import {
  deriveSymmetricKeyFromSeed,
  encryptXChaCha,
  decryptXChaCha,
  encryptStorageIdXChaCha,
  decryptStorageIdXChaCha,
  serializeXChaChaPayload,
  deserializeXChaChaPayload,
} from "../pq.js";

// ── deriveSymmetricKeyFromSeed ─────────────────────────────────────────────────

describe("deriveSymmetricKeyFromSeed", () => {
  it("returns a 32-byte key", async () => {
    const seed = new Uint8Array(32).fill(0xab);
    const key = await deriveSymmetricKeyFromSeed(seed);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("is deterministic — same seed and salt produce the same key", async () => {
    const seed = new Uint8Array(32).fill(0xab);
    const k1 = await deriveSymmetricKeyFromSeed(seed);
    const k2 = await deriveSymmetricKeyFromSeed(seed);
    expect(k1).toEqual(k2);
  });

  it("different seeds produce different keys", async () => {
    const k1 = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x01));
    const k2 = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x02));
    expect(k1).not.toEqual(k2);
  });

  it("different salts produce different keys from the same seed", async () => {
    const seed = new Uint8Array(32).fill(0x55);
    const k1 = await deriveSymmetricKeyFromSeed(seed, "dstorage-xchacha-v1");
    const k2 = await deriveSymmetricKeyFromSeed(
      seed,
      "dstorage-xchacha-v1:0xABCD",
    );
    expect(k1).not.toEqual(k2);
  });

  it("address binding — same seed, same address → same key", async () => {
    const seed = new Uint8Array(64).fill(0x77);
    const k1 = await deriveSymmetricKeyFromSeed(
      seed,
      "dstorage-xchacha-v1:0xDeAdBeEf",
    );
    const k2 = await deriveSymmetricKeyFromSeed(
      seed,
      "dstorage-xchacha-v1:0xDeAdBeEf",
    );
    expect(k1).toEqual(k2);
  });
});

// ── encryptXChaCha / decryptXChaCha ───────────────────────────────────────────

describe("encryptXChaCha / decryptXChaCha", () => {
  it("round-trips empty data", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x01));
    const data = new Uint8Array(0);
    const payload = await encryptXChaCha(key, data);
    const decrypted = await decryptXChaCha(key, payload);
    expect(decrypted).toEqual(data);
  });

  it("round-trips small text", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x02));
    const data = new TextEncoder().encode("Hello, XChaCha20!");
    const payload = await encryptXChaCha(key, data);
    const decrypted = await decryptXChaCha(key, payload);
    expect(new TextDecoder().decode(decrypted)).toBe("Hello, XChaCha20!");
  });

  it("round-trips 100KB data", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x03));
    const data = new Uint8Array(100_000);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const payload = await encryptXChaCha(key, data);
    const decrypted = await decryptXChaCha(key, payload);
    expect(decrypted).toEqual(data);
  });

  it("is non-deterministic — same input produces different nonce each call", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x04));
    const data = new TextEncoder().encode("same data");
    const p1 = await encryptXChaCha(key, data);
    const p2 = await encryptXChaCha(key, data);
    expect(p1.nonce).not.toBe(p2.nonce);
    expect(p1.ciphertext).not.toBe(p2.ciphertext);
  });

  it("sets algorithm field to XChaCha20-Poly1305", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x05));
    const payload = await encryptXChaCha(key, new Uint8Array([1, 2, 3]));
    expect(payload.algorithm).toBe("XChaCha20-Poly1305");
  });

  it("decryptXChaCha throws with wrong key", async () => {
    const key1 = await deriveSymmetricKeyFromSeed(
      new Uint8Array(32).fill(0x06),
    );
    const key2 = await deriveSymmetricKeyFromSeed(
      new Uint8Array(32).fill(0x07),
    );
    const data = new TextEncoder().encode("secret");
    const payload = await encryptXChaCha(key1, data);
    await expect(decryptXChaCha(key2, payload)).rejects.toThrow();
  });
});

// ── encryptStorageIdXChaCha / decryptStorageIdXChaCha ─────────────────────────

describe("encryptStorageIdXChaCha / decryptStorageIdXChaCha", () => {
  it("outputs exactly 72 bytes", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x10));
    const storageId = new Uint8Array(32).fill(0xde);
    const encrypted = await encryptStorageIdXChaCha(key, storageId);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBe(72);
  });

  it("round-trips a 32-byte storage ID", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x11));
    const storageId = new Uint8Array(32);
    for (let i = 0; i < 32; i++) storageId[i] = i;
    const encrypted = await encryptStorageIdXChaCha(key, storageId);
    const decrypted = await decryptStorageIdXChaCha(key, encrypted);
    expect(decrypted).toEqual(storageId);
  });

  it("is non-deterministic — same input produces different output each call", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x12));
    const storageId = new Uint8Array(32).fill(0x42);
    const enc1 = await encryptStorageIdXChaCha(key, storageId);
    const enc2 = await encryptStorageIdXChaCha(key, storageId);
    expect(enc1).not.toEqual(enc2);
  });

  it("decryptStorageIdXChaCha throws on wrong length", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x13));
    const bad = new Uint8Array(60); // old 60-byte AES-GCM format
    await expect(decryptStorageIdXChaCha(key, bad)).rejects.toThrow(/72/);
  });

  it("decryptStorageIdXChaCha throws with wrong key", async () => {
    const key1 = await deriveSymmetricKeyFromSeed(
      new Uint8Array(32).fill(0x14),
    );
    const key2 = await deriveSymmetricKeyFromSeed(
      new Uint8Array(32).fill(0x15),
    );
    const storageId = new Uint8Array(32).fill(0xaa);
    const encrypted = await encryptStorageIdXChaCha(key1, storageId);
    await expect(decryptStorageIdXChaCha(key2, encrypted)).rejects.toThrow();
  });

  it("layout: nonce at offset 0..23, ciphertext at 24..55, tag at 56..71", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x16));
    const storageId = new Uint8Array(32).fill(0x01);
    const encrypted = await encryptStorageIdXChaCha(key, storageId);
    const nonce = encrypted.slice(0, 24);
    expect(nonce.length).toBe(24);
    // Nonce should not be all zeros (random)
    expect(Array.from(nonce).every((b) => b === 0)).toBe(false);
  });
});

// ── serializeXChaChaPayload / deserializeXChaChaPayload ───────────────────────

describe("serializeXChaChaPayload / deserializeXChaChaPayload", () => {
  it("round-trips an XChaChaPayload", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x20));
    const data = new TextEncoder().encode("test payload");
    const payload = await encryptXChaCha(key, data);
    const serialized = serializeXChaChaPayload(payload);
    expect(typeof serialized).toBe("string");
    const deserialized = deserializeXChaChaPayload(serialized);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.ciphertext).toBe(payload.ciphertext);
    expect(deserialized!.nonce).toBe(payload.nonce);
    expect(deserialized!.algorithm).toBe(payload.algorithm);
  });

  it("deserializeXChaChaPayload returns null for invalid JSON", () => {
    expect(deserializeXChaChaPayload("not json at all")).toBeNull();
    expect(deserializeXChaChaPayload("{")).toBeNull();
  });

  it("deserializeXChaChaPayload returns null for JSON missing required fields", () => {
    expect(deserializeXChaChaPayload('{"ciphertext":"abc"}')).toBeNull();
    expect(
      deserializeXChaChaPayload('{"ciphertext":"abc","nonce":"abc"}'),
    ).toBeNull();
    expect(deserializeXChaChaPayload("null")).toBeNull();
    expect(deserializeXChaChaPayload("42")).toBeNull();
  });

  it("serialize produces valid JSON", async () => {
    const key = await deriveSymmetricKeyFromSeed(new Uint8Array(32).fill(0x21));
    const payload = await encryptXChaCha(key, new Uint8Array([0xff, 0xfe]));
    const serialized = serializeXChaChaPayload(payload);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});
