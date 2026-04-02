/**
 * @dstorage/chain — adapters/mock.ts
 *
 * Mock chain adapter — simulates on-chain reference storage using
 * localStorage (browser) or in-memory Map (Node.js).
 *
 * Mimics exactly what a chain adapter will do:
 * ⚠️  Not for production: not decentralised, not immutable.
 */

import type {
  ChainAdapter,
  ChainProviderName,
  ChainReference,
  ChainReferenceUpdate,
  ChainWriteResult,
  Logger,
  WalletBalances,
  DataReferenceSummary,
  ChainQuote,
} from "../types.js";
import { PaymentAdapter, MockPaymentAdapter } from "@dstorage/payment";
import type { CryptoScheme } from "@dstorage/crypto";

// ── Storage helpers ──
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

// ── Mock Adapter ──
export class MockChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "mock";
  readonly providerName: string = "Mock-Chain-Adapter";
  readonly paymentAdapter: PaymentAdapter = new MockPaymentAdapter({
    token: "MOCK",
    type: "chain",
  });

  private contractAddress: string;
  private readonly logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.logger = logger;
    // Rehydrate from localStorage if available (browser only; no-op in Node.js)
    const savedRefs = load<Record<string, ChainReference>>(
      "dstorage:chain:refs",
    );
    if (savedRefs) {
      for (const [k, v] of Object.entries(savedRefs)) refs.set(k, v);
    }
    this.contractAddress = `mock_contract_${Date.now()}`;
  }

  async estimateCost(): Promise<ChainQuote> {
    return {
      token: "MOCK",
      amount: "0.1000",
      network: this.name,
      expiresAt: Date.now() + 120_000,
    };
  }

  async writeReference(ref: ChainReference): Promise<ChainWriteResult> {
    const refId = generateRefId();
    refs.set(refId, ref);

    // Persist to localStorage
    const allRefs = Object.fromEntries(refs);
    persist("dstorage:chain:refs", allRefs);

    this.logger?.log(
      "dStorage/mock-chain",
      `Reference written → refId: ${refId}`,
    );
    return { refId, provider: this.name, writtenAt: ref.writtenAt };
  }

  async readReference(refId: string): Promise<ChainReference> {
    const ref = refs.get(refId);
    if (!ref)
      throw new Error(
        `[dStorage/mock-chain] No reference found for refId: ${refId}`,
      );
    return ref;
  }

  /** List all references (useful for demo UI) */
  async listReferences(): Promise<DataReferenceSummary[]> {
    return [...refs.entries()].map(([refId, ref]) => ({
      refId,
      storageId: ref.storageId,
      storageProvider: ref.storageProvider,
      encryptionScheme: ref.encryptionScheme ?? null,
      ownerCommitment: "",
      isOurs: true,
    }));
  }

  async removeReference(refId: string): Promise<void> {
    if (!refs.has(refId)) {
      throw new Error(
        `[dStorage/mock-chain] No reference found for refId: ${refId}`,
      );
    }
    refs.delete(refId);
    persist("dstorage:chain:refs", Object.fromEntries(refs));
    this.logger?.log(
      "dStorage/mock-chain",
      `Reference removed → refId: ${refId}`,
    );
  }

  async updateReference(
    refId: string,
    update: ChainReferenceUpdate,
  ): Promise<void> {
    const existing = refs.get(refId);
    if (!existing) {
      throw new Error(
        `[dStorage/mock-chain] No reference found for refId: ${refId}`,
      );
    }
    refs.set(refId, { ...existing, ...update });
    persist("dstorage:chain:refs", Object.fromEntries(refs));
    this.logger?.log(
      "dStorage/mock-chain",
      `Reference updated → refId: ${refId}`,
    );
  }

  async getBalances(): Promise<WalletBalances> {
    return { night: 0n, dust: 0n };
  }

  setContractAddress(address: string): void {
    this.contractAddress = address;
  }

  getContractAddress(): string {
    return this.contractAddress;
  }

  async deployDataRegistry(): Promise<string> {
    const addr = `mock_contract_${Date.now()}`;
    this.logger?.log(
      "dStorage/mock-chain",
      `DataRegistry deployed at: ${addr}`,
    );
    this.contractAddress = addr;
    return addr;
  }

  setScheme(_scheme: CryptoScheme): void {
    // Mock adapter performs no crypto internally — scheme is used by the SDK layer.
  }
}
