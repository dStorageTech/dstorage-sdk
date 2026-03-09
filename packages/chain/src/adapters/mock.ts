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
  ChainWriteResult,
  Logger,
  WalletBalances,
  DataReferencesSummary,
} from "../types.js";

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
  async listReferences(): Promise<DataReferencesSummary[]> {
    return [...refs.entries()].map(([refId, ref]) => ({
      refId,
      storageId: ref.storageId,
      storageProvider: ref.storageProvider,
    }));
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

  async getEncryptionKey(): Promise<CryptoKey | null> {
    // Generate a random ephemeral key — fine for mocking purposes
    return globalThis.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async getStorageIdKey(): Promise<CryptoKey | null> {
    return globalThis.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
}
