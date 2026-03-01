/**
 * Tests for the generic circuit call API:
 *  - MockMidnightChainAdapter.callCircuit() / queryCircuit()
 *  - MidnightChainAdapter.callCircuit / queryCircuit (throws "not supported")
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockMidnightChainAdapter } from '../adapters/mockMidnight.js';

afterEach(() => vi.useRealTimers());

// ── MockMidnightChainAdapter ─────────────────────────────────────────────────

describe('MockMidnightChainAdapter.callCircuit', () => {
  it('returns a CircuitCallResult with txHash, blockHeight, and calledAt', async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });

    const p = adapter.callCircuit('myCircuit', ['arg1', 'arg2']);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result).toHaveProperty('txHash');
    expect(result).toHaveProperty('blockHeight');
    expect(result).toHaveProperty('calledAt');
  });

  it('txHash starts with "mock-tx-"', async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });

    const p = adapter.callCircuit('myCircuit', []);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.txHash.startsWith('mock-tx-')).toBe(true);
  });

  it('blockHeight is a number at or above 1,000,000', async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });

    const p = adapter.callCircuit('myCircuit', []);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(typeof result.blockHeight).toBe('number');
    expect(result.blockHeight!).toBeGreaterThanOrEqual(1_000_000);
  });

  it('calledAt is a Unix timestamp (number)', async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });

    const p = adapter.callCircuit('myCircuit', []);
    await vi.runAllTimersAsync();
    const result = await p;

    expect(typeof result.calledAt).toBe('number');
  });

  it('successive calls return different txHashes', async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });

    const p1 = adapter.callCircuit('circuitA', ['x']);
    await vi.runAllTimersAsync();
    const r1 = await p1;

    vi.advanceTimersByTime(1); // ensure Date.now() differs
    const p2 = adapter.callCircuit('circuitB', ['y']);
    await vi.runAllTimersAsync();
    const r2 = await p2;

    expect(r1.txHash).not.toBe(r2.txHash);
  });

  it('blockHeight increments on each callCircuit call', async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });

    const p1 = adapter.callCircuit('myCircuit', []);
    await vi.runAllTimersAsync();
    const r1 = await p1;

    const p2 = adapter.callCircuit('myCircuit', []);
    await vi.runAllTimersAsync();
    const r2 = await p2;

    expect(r2.blockHeight).toBe(r1.blockHeight! + 1);
  });

  it('accepts arbitrary circuit names', async () => {
    vi.useFakeTimers();
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });

    const p = adapter.callCircuit('verifyAge', [19860101, 'ref_abc']);
    await vi.runAllTimersAsync();
    await expect(p).resolves.not.toThrow();
  });
});

describe('MockMidnightChainAdapter.queryCircuit', () => {
  it('returns undefined by default (override per test as needed)', async () => {
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });
    const result = await adapter.queryCircuit('anyQuery', []);
    expect(result).toBeUndefined();
  });

  it('accepts arbitrary query names and inputs', async () => {
    const adapter = new MockMidnightChainAdapter({ proofServerMinMs: 0, proofServerMaxMs: 0 });
    await expect(adapter.queryCircuit('checkCoverage', ['patient-123'])).resolves.not.toThrow();
  });
});

