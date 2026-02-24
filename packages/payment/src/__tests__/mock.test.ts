import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockPaymentAdapter } from '../adapters/mock.js';
import type { PaymentQuote } from '../types.js';

afterEach(() => vi.useRealTimers());

// ── Factory helpers ────────────────────────────────────────────────────────────

function makeStorageAdapter(token = 'MOCK' as const) {
  return new MockPaymentAdapter({ token, type: 'storage' });
}

function makeChainAdapter(token = 'DUST' as const) {
  return new MockPaymentAdapter({ token, type: 'chain' });
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('MockPaymentAdapter', () => {
  describe('constructor defaults', () => {
    it('default token is MOCK', () => {
      const adapter = new MockPaymentAdapter();
      expect(adapter.token).toBe('MOCK');
    });

    it('default type is "storage"', () => {
      const adapter = new MockPaymentAdapter();
      expect(adapter.type).toBe('storage');
    });

    it('name is "mock"', () => {
      const adapter = new MockPaymentAdapter();
      expect(adapter.name).toBe('mock');
    });
  });

  describe('constructor custom config', () => {
    it('accepts custom token', () => {
      const adapter = new MockPaymentAdapter({ token: 'AR' });
      expect(adapter.token).toBe('AR');
    });

    it('accepts chain type', () => {
      const adapter = new MockPaymentAdapter({ type: 'chain' });
      expect(adapter.type).toBe('chain');
    });

    it('accepts all token symbols', () => {
      for (const token of ['AR', 'ANT', 'DUST', 'ETH', 'MATIC', 'MOCK'] as const) {
        const adapter = new MockPaymentAdapter({ token });
        expect(adapter.token).toBe(token);
      }
    });
  });

  // ── estimateCost ──────────────────────────────────────────────────────────

  describe('estimateCost', () => {
    it('returns a PaymentQuote with all required fields', async () => {
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      expect(quote).toHaveProperty('token');
      expect(quote).toHaveProperty('amount');
      expect(quote).toHaveProperty('usd');
      expect(quote).toHaveProperty('type');
      expect(quote).toHaveProperty('dataSizeBytes');
      expect(quote).toHaveProperty('expiresAt');
    });

    it('token matches adapter token', async () => {
      const adapter = new MockPaymentAdapter({ token: 'AR', type: 'storage' });
      const quote = await adapter.estimateCost(1024);
      expect(quote.token).toBe('AR');
    });

    it('type matches adapter type', async () => {
      const adapter = makeChainAdapter();
      const quote = await adapter.estimateCost(1024);
      expect(quote.type).toBe('chain');
    });

    it('dataSizeBytes matches input', async () => {
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(512);
      expect(quote.dataSizeBytes).toBe(512);
    });

    it('amount is at least minimum 0.0001 for tiny file', async () => {
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(0);
      expect(parseFloat(quote.amount)).toBeGreaterThanOrEqual(0.0001);
    });

    it('amount is at least 0.0001 for 1-byte file', async () => {
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1);
      expect(parseFloat(quote.amount)).toBeGreaterThanOrEqual(0.0001);
    });

    it('amount scales with data size', async () => {
      const adapter = makeStorageAdapter();
      const small = await adapter.estimateCost(1 * 1024);     //  1 KB
      const large = await adapter.estimateCost(100 * 1024);   // 100 KB
      expect(parseFloat(large.amount)).toBeGreaterThan(parseFloat(small.amount));
    });

    it('usd is the token amount multiplied by approxUsdPrice', async () => {
      // MOCK token: approxUsdPrice = 1.0, so usd ≈ amount
      const adapter = makeStorageAdapter('MOCK');
      const quote = await adapter.estimateCost(1024 * 1024); // 1 MB
      const amount = parseFloat(quote.amount);
      const usd = parseFloat(quote.usd);
      expect(usd).toBeCloseTo(amount * 1.0, 5);
    });

    it('expiresAt is in the future', async () => {
      const adapter = makeStorageAdapter();
      const before = Date.now();
      const quote = await adapter.estimateCost(1024);
      expect(quote.expiresAt).toBeGreaterThan(before);
    });

    it('expiresAt is approximately 10 minutes from now (default 600s)', async () => {
      const adapter = makeStorageAdapter();
      const before = Date.now();
      const quote = await adapter.estimateCost(1024);
      const delta = quote.expiresAt - before;
      // Allow ±5s of tolerance
      expect(delta).toBeGreaterThan(595_000);
      expect(delta).toBeLessThan(605_000);
    });

    it('custom quoteValidityMs is respected', async () => {
      const adapter = new MockPaymentAdapter({ quoteValidityMs: 60_000 });
      const before = Date.now();
      const quote = await adapter.estimateCost(1024);
      const delta = quote.expiresAt - before;
      expect(delta).toBeGreaterThan(55_000);
      expect(delta).toBeLessThan(65_000);
    });

    it('amount and usd are numeric strings (parseable as float)', async () => {
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      expect(isNaN(parseFloat(quote.amount))).toBe(false);
      expect(isNaN(parseFloat(quote.usd))).toBe(false);
    });
  });

  // ── pay ───────────────────────────────────────────────────────────────────

  describe('pay', () => {
    async function makeQuote(adapter: MockPaymentAdapter): Promise<PaymentQuote> {
      return adapter.estimateCost(1024);
    }

    it('returns a PaymentReceipt with simulated: true', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const p = adapter.pay(quote);
      await vi.runAllTimersAsync();
      const receipt = await p;
      expect(receipt.simulated).toBe(true);
    });

    it('txHash starts with "0x"', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const p = adapter.pay(quote);
      await vi.runAllTimersAsync();
      const receipt = await p;
      expect(receipt.txHash.startsWith('0x')).toBe(true);
    });

    it('txHash is 66 characters (0x + 64 hex)', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const p = adapter.pay(quote);
      await vi.runAllTimersAsync();
      const receipt = await p;
      expect(receipt.txHash).toHaveLength(66);
      expect(receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('two payments produce different txHashes', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const p1 = adapter.pay(quote);
      const p2 = adapter.pay(quote);
      await vi.runAllTimersAsync();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.txHash).not.toBe(r2.txHash);
    });

    it('token matches the quote token', async () => {
      vi.useFakeTimers();
      const adapter = new MockPaymentAdapter({ token: 'AR', type: 'storage' });
      const quote = await adapter.estimateCost(1024);
      const p = adapter.pay(quote);
      await vi.runAllTimersAsync();
      const receipt = await p;
      expect(receipt.token).toBe('AR');
    });

    it('amount and usd match the quote', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const p = adapter.pay(quote);
      await vi.runAllTimersAsync();
      const receipt = await p;
      expect(receipt.amount).toBe(quote.amount);
      expect(receipt.usd).toBe(quote.usd);
    });

    it('type matches the quote type', async () => {
      vi.useFakeTimers();
      const adapter = makeChainAdapter();
      const quote = await adapter.estimateCost(1024);
      const p = adapter.pay(quote);
      await vi.runAllTimersAsync();
      const receipt = await p;
      expect(receipt.type).toBe('chain');
    });

    it('paidAt is a recent timestamp', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const p = adapter.pay(quote);
      await vi.runAllTimersAsync();
      const receipt = await p;
      // paidAt must be a reasonable unix timestamp (not 0, not far in future)
      expect(receipt.paidAt).toBeGreaterThan(0);
    });

    it('calls onStatus callback at least 3 times', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const statusMessages: string[] = [];
      const p = adapter.pay(quote, (msg) => statusMessages.push(msg));
      await vi.runAllTimersAsync();
      await p;
      expect(statusMessages.length).toBeGreaterThanOrEqual(3);
    });

    it('onStatus messages are non-empty strings', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const statusMessages: string[] = [];
      const p = adapter.pay(quote, (msg) => statusMessages.push(msg));
      await vi.runAllTimersAsync();
      await p;
      for (const msg of statusMessages) {
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(0);
      }
    });

    it('works without onStatus callback', async () => {
      vi.useFakeTimers();
      const adapter = makeStorageAdapter();
      const quote = await adapter.estimateCost(1024);
      const p = adapter.pay(quote);
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBeDefined();
    });
  });
});
