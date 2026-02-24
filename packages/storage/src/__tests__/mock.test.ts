import { describe, it, expect } from 'vitest';
import { MockStorageAdapter } from '../adapters/mock.js';

// Each test uses a fresh adapter instance.
// The module-level memoryStore is shared within this file but tests use
// unique IDs (from upload) so they don't interfere with each other.

describe('MockStorageAdapter', () => {
  it('name is "mock"', () => {
    const adapter = new MockStorageAdapter();
    expect(adapter.name).toBe('mock');
  });

  // ── upload ───────────────────────────────────────────────────────────────

  describe('upload', () => {
    it('returns an UploadResult with all required fields', async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload('hello world');
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('provider');
      expect(result).toHaveProperty('cost');
      expect(result).toHaveProperty('uploadedAt');
    });

    it('id starts with "mock_"', async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload('data');
      expect(result.id.startsWith('mock_')).toBe(true);
    });

    it('provider is "mock"', async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload('data');
      expect(result.provider).toBe('mock');
    });

    it('cost is "0 (mock)"', async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload('data');
      expect(result.cost).toBe('0 (mock)');
    });

    it('uploadedAt is a recent timestamp', async () => {
      const before = Date.now();
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload('data');
      const after = Date.now();
      expect(result.uploadedAt).toBeGreaterThanOrEqual(before);
      expect(result.uploadedAt).toBeLessThanOrEqual(after);
    });

    it('each upload returns a unique id', async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.upload('a');
      const r2 = await adapter.upload('b');
      const r3 = await adapter.upload('c');
      const ids = new Set([r1.id, r2.id, r3.id]);
      expect(ids.size).toBe(3);
    });

    it('works with no metadata argument', async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.upload('data')).resolves.toBeDefined();
    });

    it('works with empty metadata object', async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.upload('data', {})).resolves.toBeDefined();
    });

    it('works with metadata key-value pairs', async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload('data', {
        'dstorage-version': '0.1.0',
        'dstorage-owner': '0xAlice',
      });
      expect(result.id).toBeDefined();
    });

    it('uploads empty string without error', async () => {
      const adapter = new MockStorageAdapter();
      const result = await adapter.upload('');
      expect(result.id).toBeDefined();
    });

    it('uploads valid JSON string', async () => {
      const adapter = new MockStorageAdapter();
      const json = JSON.stringify({ key: 'value', nested: [1, 2, 3] });
      const result = await adapter.upload(json);
      expect(result.id).toBeDefined();
    });

    it('uploads binary-safe base64 string', async () => {
      const adapter = new MockStorageAdapter();
      const b64 = btoa('\x00\x01\x02\xFF');
      const result = await adapter.upload(b64);
      expect(result.id).toBeDefined();
    });
  });

  // ── retrieve ─────────────────────────────────────────────────────────────

  describe('retrieve', () => {
    it('returns the exact data that was uploaded', async () => {
      const adapter = new MockStorageAdapter();
      const data = 'exact content match test';
      const { id } = await adapter.upload(data);
      const retrieved = await adapter.retrieve(id);
      expect(retrieved).toBe(data);
    });

    it('retrieves JSON string unchanged', async () => {
      const adapter = new MockStorageAdapter();
      const json = JSON.stringify({ patient: 'Alice', active: true });
      const { id } = await adapter.upload(json);
      const retrieved = await adapter.retrieve(id);
      expect(retrieved).toBe(json);
    });

    it('retrieves empty string correctly', async () => {
      const adapter = new MockStorageAdapter();
      const { id } = await adapter.upload('');
      const retrieved = await adapter.retrieve(id);
      expect(retrieved).toBe('');
    });

    it('throws for unknown id with the correct error message', async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.retrieve('mock_nonexistent_id')).rejects.toThrow(
        '[dStorage/mock] No data found for id: mock_nonexistent_id. Was it uploaded in this session?'
      );
    });

    it('throws for completely invalid id', async () => {
      const adapter = new MockStorageAdapter();
      await expect(adapter.retrieve('garbage')).rejects.toThrow('[dStorage/mock]');
    });

    it('multiple items: each id retrieves its own data', async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.upload('content A');
      const r2 = await adapter.upload('content B');
      const r3 = await adapter.upload('content C');
      expect(await adapter.retrieve(r1.id)).toBe('content A');
      expect(await adapter.retrieve(r2.id)).toBe('content B');
      expect(await adapter.retrieve(r3.id)).toBe('content C');
    });

    it('retrieve after multiple writes does not corrupt earlier entries', async () => {
      const adapter = new MockStorageAdapter();
      const { id: id1 } = await adapter.upload('first');
      await adapter.upload('second');
      await adapter.upload('third');
      expect(await adapter.retrieve(id1)).toBe('first');
    });
  });

  // ── estimateCost ──────────────────────────────────────────────────────────

  describe('estimateCost', () => {
    it('returns the mock cost string', async () => {
      const adapter = new MockStorageAdapter();
      const cost = await adapter.estimateCost('any data');
      expect(cost).toBe('0 (mock — no real storage cost)');
    });

    it('returns the same string regardless of data size', async () => {
      const adapter = new MockStorageAdapter();
      const costSmall = await adapter.estimateCost('x');
      const costLarge = await adapter.estimateCost('x'.repeat(1_000_000));
      expect(costSmall).toBe(costLarge);
    });
  });

  // ── listAll ───────────────────────────────────────────────────────────────

  describe('listAll', () => {
    it('returns an array', async () => {
      const adapter = new MockStorageAdapter();
      expect(Array.isArray(adapter.listAll())).toBe(true);
    });

    it('includes the id of an uploaded item', async () => {
      const adapter = new MockStorageAdapter();
      const { id } = await adapter.upload('list-test-data');
      expect(adapter.listAll()).toContain(id);
    });

    it('includes all uploaded ids', async () => {
      const adapter = new MockStorageAdapter();
      const r1 = await adapter.upload('list-a');
      const r2 = await adapter.upload('list-b');
      const all = adapter.listAll();
      expect(all).toContain(r1.id);
      expect(all).toContain(r2.id);
    });
  });
});
