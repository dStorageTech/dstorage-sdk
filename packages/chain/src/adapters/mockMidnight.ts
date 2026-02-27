/**
 * @dstorage/chain — adapters/mockMidnight.ts
 *
 * Mock Midnight chain adapter — simulates the full Midnight transaction
 * flow including proof-server invocation, without requiring a live network.
 *
 * When `writeReference()` is called the adapter will:
 *   1. Call the MockProofServer to generate a ZK proof (simulated).
 *   2. "Submit" a balanced transaction to the mock Midnight node (simulated delay).
 *   3. Persist the reference locally (localStorage or in-memory Map).
 *
 * Access control (grantAccess / revokeAccess / hasAccess) also simulates
 * the on-chain permission ledger, but without the proof overhead because
 * access-control transactions use a simpler circuit.
 *
 * ⚠️  Not for production: not decentralised, not immutable.
 *     Replace with the real MidnightChainAdapter once Midnight.js v1 is stable.
 */

import type {
  ChainAdapter,
  ChainPermission,
  ChainProviderName,
  ChainReference,
  ChainWriteResult,
  CircuitCallResult,
} from '../types.js';
import { MockProofServer } from '../mockProofServer.js';

// ── Storage helpers ────────────────────────────────────────────────────────────

const refs        = new Map<string, ChainReference>();
const permissions = new Map<string, Set<string>>();

function generateRefId(): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ref_${id}`;
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage not available in this environment (e.g. Node.js)
  }
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // localStorage not available in this environment (e.g. Node.js)
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Simulated block height counter (monotonically increases) */
let mockBlockHeight = 1_000_000 + Math.floor(Math.random() * 10_000);

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MockMidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = 'midnight';

  private readonly proofServer: MockProofServer;

  constructor(options: {
    proofServerMinMs?: number;
    proofServerMaxMs?: number;
    /** For API symmetry with MidnightChainAdapter. Stored but unused by the mock. */
    compiledContract?: unknown;
    /** For API symmetry with MidnightChainAdapter. Stored but unused by the mock. */
    contractAddress?: string;
  } = {}) {
    this.proofServer = new MockProofServer({
      ...(options.proofServerMinMs !== undefined ? { minMs: options.proofServerMinMs } : {}),
      ...(options.proofServerMaxMs !== undefined ? { maxMs: options.proofServerMaxMs } : {}),
    });

    // Rehydrate from localStorage if available (browser only; no-op in Node.js)
    const savedRefs = load<Record<string, ChainReference>>('dstorage:midnight:refs');
    if (savedRefs) {
      for (const [k, v] of Object.entries(savedRefs)) refs.set(k, v);
    }
  }

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    console.log('[dStorage/mock-midnight] writeReference → calling proof server…');

    // Step 1: Generate ZK proof via mock proof server
    await this.proofServer.generateProof('storeReference', {
      storageId:       ref.storageId,
      storageProvider: ref.storageProvider,
      owner:           ref.owner,
    });

    // Step 2: Simulate submitting the balanced transaction to the Midnight node
    const blockInclusionMs = 150 + Math.random() * 250;
    console.log('[dStorage/mock-midnight] Submitting balanced tx to Midnight node…');
    await sleep(blockInclusionMs);

    mockBlockHeight += 1;
    const refId = generateRefId();
    const entry: ChainReference = { ...ref, createdAt: Date.now() };
    refs.set(refId, entry);

    // Persist to localStorage
    persist('dstorage:midnight:refs', Object.fromEntries(refs));

    console.log(
      `[dStorage/mock-midnight] Reference written at block ${mockBlockHeight} → refId: ${refId}`
    );

    return { refId, provider: 'midnight', blockHeight: mockBlockHeight, writtenAt: Date.now() };
  }

  async readReference(refId: string): Promise<ChainReference> {
    const ref = refs.get(refId);
    if (!ref) {
      throw new Error(`[dStorage/mock-midnight] No reference found for refId: ${refId}`);
    }
    return ref;
  }

  async grantAccess(permission: ChainPermission): Promise<string> {
    const { refId, grantee } = permission;

    // Simulate a lightweight proof for the access-grant circuit
    await this.proofServer.generateProof('grantAccess', { refId, grantee });

    if (!permissions.has(refId)) permissions.set(refId, new Set());
    permissions.get(refId)!.add(grantee);

    // Persist
    const allPerms: Record<string, string[]> = {};
    for (const [k, v] of permissions.entries()) allPerms[k] = [...v];
    persist('dstorage:midnight:perms', allPerms);

    const permId = `perm_${refId}_${grantee}`;
    console.log(`[dStorage/mock-midnight] Access granted: ${grantee} → ${refId}`);
    return permId;
  }

  async revokeAccess(refId: string, grantee: string): Promise<void> {
    permissions.get(refId)?.delete(grantee);
    console.log(`[dStorage/mock-midnight] Access revoked: ${grantee} → ${refId}`);
  }

  async hasAccess(refId: string, wallet: string): Promise<boolean> {
    const ref = refs.get(refId);
    // Owner always has access
    if (ref?.owner === wallet) return true;
    return permissions.get(refId)?.has(wallet) ?? false;
  }

  /** List all references (useful for demo UI) */
  getAllReferences(): Array<{ refId: string; ref: ChainReference }> {
    return [...refs.entries()].map(([refId, ref]) => ({ refId, ref }));
  }

  async listReferences(): Promise<Array<{ refId: string; ref: ChainReference }>> {
    return this.getAllReferences();
  }

  // ── Generic circuit API ───────────────────────────────────────────────────

  async callCircuit(circuitName: string, inputs: unknown[]): Promise<CircuitCallResult> {
    await this.proofServer.generateProof(circuitName, inputs);

    // Simulate block inclusion delay
    await sleep(150 + Math.random() * 250);
    mockBlockHeight += 1;

    return {
      txHash:      `mock-tx-${Date.now()}`,
      blockHeight: mockBlockHeight,
      calledAt:    Date.now(),
    };
  }

  async queryCircuit<T = unknown>(_queryName: string, _inputs: unknown[]): Promise<T> {
    // Default mock returns undefined — override per test as needed
    return undefined as T;
  }
}
