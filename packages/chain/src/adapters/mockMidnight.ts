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
  ChainProviderName,
  ChainReference,
  ChainWriteResult,
  DataReferencesSummary,
  Logger,
} from "../types.js";
import { MockProofServer } from "../mockProofServer.js";

// ── Storage helpers ────────────────────────────────────────────────────────────

const refs = new Map<string, ChainReference>();
const permissions = new Map<string, Set<string>>();

function generateRefId(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simulated block height counter (monotonically increases) */
let mockBlockHeight = 1_000_000 + Math.floor(Math.random() * 10_000);

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MockMidnightChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "midnight";
  readonly providerName: string = "Midnight-Mock";

  private readonly proofServer: MockProofServer;
  private readonly logger: Logger | undefined;

  constructor(
    options: {
      proofServerMinMs?: number;
      proofServerMaxMs?: number;
      /** For API symmetry with MidnightChainAdapter. Stored but unused by the mock. */
      compiledContract?: unknown;
      /** For API symmetry with MidnightChainAdapter. Stored but unused by the mock. */
      contractAddress?: string;
      logger?: Logger;
    } = {},
  ) {
    this.logger = options.logger;
    this.proofServer = new MockProofServer({
      ...(options.proofServerMinMs !== undefined
        ? { minMs: options.proofServerMinMs }
        : {}),
      ...(options.proofServerMaxMs !== undefined
        ? { maxMs: options.proofServerMaxMs }
        : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });

    // Rehydrate from localStorage if available (browser only; no-op in Node.js)
    const savedRefs = load<Record<string, ChainReference>>(
      "dstorage:midnight:refs",
    );
    if (savedRefs) {
      for (const [k, v] of Object.entries(savedRefs)) refs.set(k, v);
    }
  }

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    this.logger?.log(
      "dStorage/mock-midnight",
      "writeReference → calling proof server…",
    );

    // Step 1: Generate ZK proof via mock proof server
    await this.proofServer.generateProof("storeReference", ref);

    // Step 2: Simulate submitting the balanced transaction to the Midnight node
    const blockInclusionMs = 150 + Math.random() * 250;
    this.logger?.log(
      "dStorage/mock-midnight",
      "Submitting balanced tx to Midnight node…",
    );
    await sleep(blockInclusionMs);

    mockBlockHeight += 1;
    const refId = generateRefId();
    refs.set(refId, ref);

    // Persist to localStorage
    persist("dstorage:midnight:refs", Object.fromEntries(refs));

    this.logger?.log(
      "dStorage/mock-midnight",
      `Reference written at block ${mockBlockHeight} → refId: ${refId}`,
    );

    return {
      refId,
      provider: this.name,
      blockHeight: mockBlockHeight,
      writtenAt: ref.writtenAt,
    };
  }

  async readReference(refId: string): Promise<ChainReference> {
    const ref = refs.get(refId);
    if (!ref) {
      throw new Error(
        `[dStorage/mock-midnight] No reference found for refId: ${refId}`,
      );
    }
    return ref;
  }

  /** List all references (useful for demo UI) */
  async listReferences(): Promise<DataReferencesSummary[]> {
    return [...refs.entries()].map(([refId, ref]) => ({
      refId,
      storageId: ref.storageId,
      storageProvider: ref.storageProvider,
    }));
  }

  // ── DataRegistry deployment stubs ─────────────────────────────────────────

  setContractAddress(_address: string): void {
    // No-op for mock — contract address is not used
  }

  getContractAddress(): string {
    return "mock-midnight-contract-address";
  }

  async deployDataRegistry(): Promise<string> {
    await this.proofServer.generateProof("constructor", {});
    await sleep(150 + Math.random() * 100);
    const addr = `mock_contract_${Date.now()}`;
    this.logger?.log(
      "dStorage/mock-midnight",
      `DataRegistry deployed at: ${addr}`,
    );
    return addr;
  }

  async getEncryptionKey(): Promise<CryptoKey | null> {
    const { KeyDeriver } = await import("@dstorage/crypto");
    // Fixed test mnemonic for deterministic mock encryption key
    return new KeyDeriver({
      mnemonic: "test test test test test test test test test test test junk",
    }).deriveEncryptionKey();
  }

  async getStorageIdKey(): Promise<CryptoKey | null> {
    const { KeyDeriver } = await import("@dstorage/crypto");
    // Fixed test mnemonic for deterministic mock storageId key
    return new KeyDeriver({
      mnemonic: "test test test test test test test test test test test junk",
    }).deriveStorageIdKey();
  }
}
