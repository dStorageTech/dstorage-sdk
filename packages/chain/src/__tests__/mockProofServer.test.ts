import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockProofServer } from '../mockProofServer.js';

afterEach(() => vi.useRealTimers());

describe('MockProofServer', () => {
  // ── Structure validation ──────────────────────────────────────────────────

  describe('generateProof (instant config)', () => {
    it('returns a MockProof object with all required fields', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', { storageId: 'sid', owner: '0xA' });
      await vi.runAllTimersAsync();
      const proof = await p;

      expect(proof).toHaveProperty('commitment');
      expect(proof).toHaveProperty('nullifier');
      expect(proof).toHaveProperty('proofBytes');
      expect(proof).toHaveProperty('circuit');
      expect(proof).toHaveProperty('provingTimeMs');
    });

    it('circuit field matches the input circuit name', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('grantAccess', { refId: 'r1', grantee: '0xBob' });
      await vi.runAllTimersAsync();
      const proof = await p;
      expect(proof.circuit).toBe('grantAccess');
    });

    it('commitment starts with "0x"', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const proof = await p;
      expect(proof.commitment.startsWith('0x')).toBe(true);
    });

    it('nullifier starts with "0x"', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const proof = await p;
      expect(proof.nullifier.startsWith('0x')).toBe(true);
    });

    it('proofBytes starts with "0x"', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const proof = await p;
      expect(proof.proofBytes.startsWith('0x')).toBe(true);
    });

    it('commitment is a 66-character hex string (0x + 64 hex chars)', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const proof = await p;
      expect(proof.commitment).toHaveLength(66);
      expect(proof.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('nullifier is a 66-character hex string', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const proof = await p;
      expect(proof.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('provingTimeMs is a non-negative number', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const proof = await p;
      expect(typeof proof.provingTimeMs).toBe('number');
      expect(proof.provingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('proofBytes has substantial length (simulated proof data)', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const proof = await p;
      // 0x + at least 128 hex chars = at least 130 chars
      expect(proof.proofBytes.length).toBeGreaterThanOrEqual(130);
    });
  });

  // ── Randomness ────────────────────────────────────────────────────────────

  describe('randomness', () => {
    it('two proofs for same inputs produce different commitments', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p1 = server.generateProof('storeReference', { id: 'x' });
      const p2 = server.generateProof('storeReference', { id: 'x' });
      await vi.runAllTimersAsync();
      const [proof1, proof2] = await Promise.all([p1, p2]);
      expect(proof1.commitment).not.toBe(proof2.commitment);
    });

    it('two proofs produce different nullifiers', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p1 = server.generateProof('storeReference', {});
      const p2 = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const [proof1, proof2] = await Promise.all([p1, p2]);
      expect(proof1.nullifier).not.toBe(proof2.nullifier);
    });

    it('commitment and nullifier within the same proof are different', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      const proof = await p;
      expect(proof.commitment).not.toBe(proof.nullifier);
    });
  });

  // ── Timing ────────────────────────────────────────────────────────────────

  describe('timing configuration', () => {
    it('accepts different circuit names without error', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const circuits = ['storeReference', 'grantAccess', 'revokeAccess', 'hasAccess', 'custom'];
      for (const circuit of circuits) {
        const p = server.generateProof(circuit, {});
        await vi.runAllTimersAsync();
        const proof = await p;
        expect(proof.circuit).toBe(circuit);
      }
    });

    it('accepts empty inputs object', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', {});
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBeDefined();
    });

    it('accepts null inputs', async () => {
      vi.useFakeTimers();
      const server = new MockProofServer({ minMs: 0, maxMs: 0 });
      const p = server.generateProof('storeReference', null);
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBeDefined();
    });

    it('default constructor uses sensible timing range', () => {
      // Just ensure the default constructor does not throw
      expect(() => new MockProofServer()).not.toThrow();
    });
  });
});
