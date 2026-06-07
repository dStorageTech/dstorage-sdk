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
  ChainReferenceUpdate,
  ChainWriteResult,
  DataReferenceSummary,
  ChainAdapterLogger,
  ChainQuote,
} from "../types.js";
import { MockProofServer } from "../mockProofServer.js";
import { ManagedPaymentAdapter, MockPaymentAdapter } from "@dstorage/payment";
import type { PaymentAdapter } from "@dstorage/payment";

// ── Storage helpers ────────────────────────────────────────────────────────────

const refs = new Map<string, ChainReference>();

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
  readonly paymentAdapter: PaymentAdapter;

  private readonly proofServer: MockProofServer;
  private readonly logger: ChainAdapterLogger | undefined;

  constructor(
    options: {
      proofServerMinMs?: number;
      proofServerMaxMs?: number;
      /** For API symmetry with MidnightChainAdapter. Stored but unused by the mock. */
      compiledContract?: unknown;
      /** For API symmetry with MidnightChainAdapter. Stored but unused by the mock. */
      contractAddress?: string;
      logger?: ChainAdapterLogger;
    } & (
      | { signingServerUrl: string; authToken: string }
      | { signingServerUrl?: never; authToken?: never }
    ) = {},
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
    if (options.signingServerUrl) {
      this.paymentAdapter = new ManagedPaymentAdapter({
        network: "managedmock",
        type: "chain",
        signingServerUrl: options.signingServerUrl,
        authToken: options.authToken,
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
      });
    } else {
      this.paymentAdapter = new MockPaymentAdapter({
        type: "chain",
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
      });
    }

    // Rehydrate from localStorage if available (browser only; no-op in Node.js)
    const savedRefs = load<Record<string, ChainReference>>(
      "dstorage:midnight:refs",
    );
    if (savedRefs) {
      for (const [k, v] of Object.entries(savedRefs)) refs.set(k, v);
    }
  }

  async estimateCost(): Promise<ChainQuote> {
    return {
      token: "DUST",
      amount: "0.1000",
      network: this.name,
      expiresAt: Date.now() + 120_000,
    };
  }

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    this.logger?.log(
      "dStorage/mock-midnight",
      "writeReference → calling proof server…",
    );

    if (!ref.keyEnvelope) {
      throw new Error("[dStorage] keyEnvelope is required for all references");
    }

    // Step 1: Generate ZK proof via mock proof server
    await this.proofServer.generateProof("storeReference");

    // Step 2: Sign the transaction via the managed payment service (if configured)
    let paymentReceipt;
    if (this.paymentAdapter) {
      this.logger?.log(
        "dStorage/mock-midnight",
        "Sending request to balance Tx to remote service…",
      );
      paymentReceipt = await this.paymentAdapter.pay({
        network: this.name,
        dataSizeBytes: 0,
        expiresAt: Date.now() + 60_000,
      });
    }

    // Step 3: Simulate submitting the balanced transaction to the Midnight node
    const blockInclusionMs = 150 + Math.random() * 250;
    this.logger?.log(
      "dStorage/mock-midnight",
      "Submitting balanced tx to Midnight node…",
    );
    await sleep(blockInclusionMs);

    mockBlockHeight += 1;
    const refId = ref.refId ?? generateRefId();
    refs.set(refId, ref);

    // Persist to localStorage
    persist("dstorage:midnight:refs", Object.fromEntries(refs));

    this.logger?.log(
      "dStorage/mock-midnight",
      `Reference written at block ${mockBlockHeight} → refId: ${refId}`,
    );
    this.logger?.log(
      "dStorage/mock-midnight",
      "⚠️  Reference is NOT written on the real Midnight network.",
    );

    return {
      refId,
      provider: this.name,
      blockHeight: mockBlockHeight,
      writtenAt: ref.writtenAt,
      ...(paymentReceipt ? { paymentReceipt } : {}),
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
  async listReferences(): Promise<DataReferenceSummary[]> {
    return [...refs.entries()].map(([refId, ref]) => ({
      refId,
      storageId: ref.storageId,
      storageProvider: ref.storageProvider,
      encryptionScheme: ref.encryptionScheme ?? null,
      keyEnvelope: ref.keyEnvelope ?? "",
      ownerCommitment: "",
    }));
  }

  async removeReference(
    refId: string,
    _ownerSecret?: Uint8Array,
  ): Promise<void> {
    this.logger?.log(
      "dStorage/mock-midnight",
      "removeReference → calling proof server…",
    );

    // Simulate ZK proof generation for removeReference circuit
    await this.proofServer.generateProof("removeReference");

    // Simulate block inclusion delay
    await sleep(150 + Math.random() * 250);

    if (!refs.has(refId)) {
      throw new Error(
        `[dStorage/mock-midnight] No reference found for refId: ${refId}`,
      );
    }
    refs.delete(refId);
    persist("dstorage:midnight:refs", Object.fromEntries(refs));
    mockBlockHeight += 1;

    this.logger?.log(
      "dStorage/mock-midnight",
      `Reference removed at block ${mockBlockHeight} → refId: ${refId}`,
    );
  }

  async updateReference(
    refId: string,
    update: ChainReferenceUpdate,
    _ownerSecret?: Uint8Array,
  ): Promise<void> {
    this.logger?.log(
      "dStorage/mock-midnight",
      "updateReference → calling proof server…",
    );

    // Simulate ZK proof generation for updateReference circuit
    await this.proofServer.generateProof("updateReference");

    // Simulate block inclusion delay
    await sleep(150 + Math.random() * 250);

    const existing = refs.get(refId);
    if (!existing) {
      throw new Error(
        `[dStorage/mock-midnight] No reference found for refId: ${refId}`,
      );
    }
    refs.set(refId, { ...existing, ...update });
    persist("dstorage:midnight:refs", Object.fromEntries(refs));
    mockBlockHeight += 1;

    this.logger?.log(
      "dStorage/mock-midnight",
      `Reference updated at block ${mockBlockHeight} → refId: ${refId}`,
    );
  }

  // ── DataRegistry deployment stubs ─────────────────────────────────────────

  setContractAddress(_address: string): void {
    // No-op for mock — contract address is not used
  }

  getContractAddress(): string {
    return "mock-midnight-contract-address";
  }

  async deployDataRegistry(): Promise<string> {
    await this.proofServer.generateProof("constructor");
    await sleep(150 + Math.random() * 100);
    const addr = `mock_contract_${Date.now()}`;
    this.logger?.log(
      "dStorage/mock-midnight",
      `DataRegistry deployed at: ${addr}`,
    );
    return addr;
  }
}
