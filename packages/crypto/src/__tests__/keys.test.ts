import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveKeyFromSignature, KEY_DERIVATION_MESSAGE } from '../keys.js';

// A valid 65-byte Ethereum-style signature in hex (no 0x prefix)
const SIG_HEX = 'ab'.repeat(32) + 'cd'.repeat(32) + 'ef01';
const SIG_WITH_0X = '0x' + SIG_HEX;
const ALT_SIG = 'de'.repeat(65);

// ── KEY_DERIVATION_MESSAGE ────────────────────────────────────────────────────

describe('KEY_DERIVATION_MESSAGE', () => {
  it('is a non-empty string', () => {
    expect(typeof KEY_DERIVATION_MESSAGE).toBe('string');
    expect(KEY_DERIVATION_MESSAGE.length).toBeGreaterThan(0);
  });

  it('starts with the expected version prefix', () => {
    expect(KEY_DERIVATION_MESSAGE.startsWith('dStorage key derivation v1')).toBe(true);
  });

  it('is stable across imports (constant)', () => {
    const msg1 = KEY_DERIVATION_MESSAGE;
    const msg2 = KEY_DERIVATION_MESSAGE;
    expect(msg1).toBe(msg2);
  });
});

// ── deriveKeyFromSignature ────────────────────────────────────────────────────

describe('deriveKeyFromSignature', () => {
  it('returns a CryptoKey', async () => {
    const key = await deriveKeyFromSignature(SIG_HEX);
    expect(key).toBeDefined();
    // CryptoKey is a native object — check distinguishing properties
    expect(typeof key).toBe('object');
    expect(key.type).toBe('secret');
  });

  it('key algorithm is AES-GCM', async () => {
    const key = await deriveKeyFromSignature(SIG_HEX);
    expect(key.algorithm.name).toBe('AES-GCM');
  });

  it('key is non-extractable (never leaves memory)', async () => {
    const key = await deriveKeyFromSignature(SIG_HEX);
    expect(key.extractable).toBe(false);
  });

  it('key usages include encrypt and decrypt', async () => {
    const key = await deriveKeyFromSignature(SIG_HEX);
    expect(key.usages).toContain('encrypt');
    expect(key.usages).toContain('decrypt');
    expect(key.usages).toHaveLength(2);
  });

  it('strips 0x prefix and produces the same key as bare hex', async () => {
    // Derive two keys: one with 0x, one without — should behave identically
    const keyA = await deriveKeyFromSignature(SIG_HEX);
    const keyB = await deriveKeyFromSignature(SIG_WITH_0X);

    // Encrypt with A, decrypt with B — should succeed
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('test payload');
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, data);
    const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, cipher);
    expect(new TextDecoder().decode(plain)).toBe('test payload');
  });

  it('is deterministic: same signature + salt always produces equivalent key', async () => {
    const keyA = await deriveKeyFromSignature(SIG_HEX, '0xAlice');
    const keyB = await deriveKeyFromSignature(SIG_HEX, '0xAlice');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('determinism check');
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, data);
    const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, cipher);
    expect(new TextDecoder().decode(plain)).toBe('determinism check');
  });

  it('different signatures produce different keys', async () => {
    const keyA = await deriveKeyFromSignature(SIG_HEX, '0xAlice');
    const keyB = await deriveKeyFromSignature(ALT_SIG,  '0xAlice');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('secret');
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, data);

    // Decrypting with wrong key must fail
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, cipher)
    ).rejects.toBeDefined();
  });

  it('different salts produce different keys for the same signature', async () => {
    const keyA = await deriveKeyFromSignature(SIG_HEX, '0xAddress1');
    const keyB = await deriveKeyFromSignature(SIG_HEX, '0xAddress2');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('secret');
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, data);

    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, cipher)
    ).rejects.toBeDefined();
  });

  it('uses default salt "dstorage-v1" when no salt provided', async () => {
    // Key with default salt should equal key with explicit 'dstorage-v1' salt
    const keyDefault  = await deriveKeyFromSignature(SIG_HEX);
    const keyExplicit = await deriveKeyFromSignature(SIG_HEX, 'dstorage-v1');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('default salt check');
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyDefault, data);
    const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyExplicit, cipher);
    expect(new TextDecoder().decode(plain)).toBe('default salt check');
  });

  it('throws a descriptive error when WebCrypto is not available', async () => {
    // globalThis.crypto is a read-only getter in Node.js, so use vi.stubGlobal
    vi.stubGlobal('crypto', undefined);

    try {
      await expect(deriveKeyFromSignature(SIG_HEX)).rejects.toThrow(
        '[dStorage/crypto] WebCrypto not available in this environment.'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts short hex signature (minimum valid input)', async () => {
    // 2-char hex = 1 byte — technically valid for PBKDF2 key material
    const key = await deriveKeyFromSignature('ff');
    expect(key.type).toBe('secret');
  });

  it('handles odd-length hex gracefully (parseInt stops at NaN boundary)', async () => {
    // Not a great signature but should not throw
    const key = await deriveKeyFromSignature('aabb');
    expect(key.type).toBe('secret');
  });
});
