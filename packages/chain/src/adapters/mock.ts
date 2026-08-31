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
  ChainAdapterLogger,
  WalletBalances,
  DataReferenceSummary,
  ChainQuote,
} from "../types.js";
import {
  PaymentAdapter,
  MockPaymentAdapter,
  ManagedPaymentAdapter,
} from "@dstorage/payment";
import type { ManagedPaymentOptions } from "@dstorage/payment";
import { DStorageError, assertValidLogger } from "@dstorage/crypto";
import { ChainErrorCode } from "../errors.js";

// ── Storage helpers ──
const refs = new Map<string, ChainReference>();
// SHA-256(ownerSecret) stored at write time; checked on remove/update.
// In-memory only — not persisted to localStorage (mock limitation).
const commitments = new Map<string, Uint8Array>();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

export type MockChainAdapterConfig = {
  /**
   * Optional logger for SDK operational output.
   */
  logger?: ChainAdapterLogger;
  managedPayment?: ManagedPaymentOptions;
};

// ── Mock Adapter ──
export class MockChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "mock";
  readonly providerName: string = "Mock-Chain-Adapter";
  readonly paymentAdapter: PaymentAdapter;

  private contractAddress: string;
  private readonly logger: ChainAdapterLogger | undefined;

  constructor(config: MockChainAdapterConfig = {}) {
    assertValidLogger(config.logger, "MockChainAdapter");
    this.logger = config.logger;

    if (config.managedPayment) {
      if (!config.managedPayment.authToken?.trim()) {
        throw new DStorageError(
          ChainErrorCode.MOCK_AUTH_TOKEN_REQUIRED,
          "[dStorage/mock-chain] authToken is required when signingServerUrl is provided.",
        );
      }
      this.paymentAdapter = new ManagedPaymentAdapter({
        network: "managedmock",
        type: "chain",
        managedPayment: config.managedPayment,
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
      });
    } else {
      this.paymentAdapter = new MockPaymentAdapter({ type: "chain" });
    }

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
    this.logger?.log(
      "dStorage/mock-chain",
      "Sending request to balance Tx to remote service…",
    );
    const paymentReceipt = await this.paymentAdapter.pay({
      network: this.name,
      dataSizeBytes: 0,
      expiresAt: Date.now() + 60_000,
      ...(ref.contentHash !== undefined ? { txData: ref.contentHash } : {}),
    });

    const refId = ref.refId ?? generateRefId();
    refs.set(refId, ref);
    if (ref.ownerSecret) {
      commitments.set(refId, await sha256(ref.ownerSecret));
    }

    // Persist to localStorage
    const allRefs = Object.fromEntries(refs);
    persist("dstorage:chain:refs", allRefs);

    this.logger?.log(
      "dStorage/mock-chain",
      `Reference written → refId: ${refId}`,
    );
    return {
      refId,
      provider: this.name,
      writtenAt: ref.writtenAt,
      paymentReceipt,
    };
  }

  async readReference(refId: string): Promise<ChainReference> {
    const ref = refs.get(refId);
    if (!ref)
      throw new DStorageError(
        ChainErrorCode.MOCK_REF_NOT_FOUND,
        `[dStorage/mock-chain] No reference found for refId: ${refId}`,
      );
    return ref;
  }

  /** List all references (useful for demo UI) */
  async listReferences(): Promise<DataReferenceSummary[]> {
    return [...refs.entries()].map(([refId, ref]) => ({
      refId,
      storageId: ref.storageId ?? null,
      storageProvider: ref.storageProvider ?? "",
      encryptionScheme: ref.encryptionScheme ?? null,
      ownerCommitment: commitments.has(refId)
        ? bytesToHex(commitments.get(refId)!)
        : "",
      keyEnvelope: ref.keyEnvelope ?? "",
      ...(ref.encryptedMetadata
        ? { encryptedMetadata: ref.encryptedMetadata }
        : {}),
    }));
  }

  async removeReference(
    refId: string,
    ownerSecret?: Uint8Array,
  ): Promise<void> {
    if (!refs.has(refId)) {
      throw new DStorageError(
        ChainErrorCode.MOCK_REF_NOT_FOUND_REMOVE,
        `[dStorage/mock-chain] No reference found for refId: ${refId}`,
      );
    }
    await this._checkOwnerSecret(refId, ownerSecret);
    refs.delete(refId);
    commitments.delete(refId);
    persist("dstorage:chain:refs", Object.fromEntries(refs));
    this.logger?.log(
      "dStorage/mock-chain",
      `Reference removed → refId: ${refId}`,
    );
  }

  async updateReference(
    refId: string,
    update: ChainReferenceUpdate,
    ownerSecret?: Uint8Array,
    newOwnerSecret?: Uint8Array,
  ): Promise<void> {
    const existing = refs.get(refId);
    if (!existing) {
      throw new DStorageError(
        ChainErrorCode.MOCK_REF_NOT_FOUND_UPDATE,
        `[dStorage/mock-chain] No reference found for refId: ${refId}`,
      );
    }
    await this._checkOwnerSecret(refId, ownerSecret);
    refs.set(refId, { ...existing, ...update });
    if (newOwnerSecret) {
      commitments.set(refId, await sha256(newOwnerSecret));
    }
    persist("dstorage:chain:refs", Object.fromEntries(refs));
    this.logger?.log(
      "dStorage/mock-chain",
      `Reference updated → refId: ${refId}`,
    );
  }

  private async _checkOwnerSecret(
    refId: string,
    ownerSecret: Uint8Array | undefined,
  ): Promise<void> {
    const stored = commitments.get(refId);
    if (!stored) return;
    if (!ownerSecret) {
      throw new DStorageError(
        ChainErrorCode.MOCK_OWNER_SECRET_REQUIRED,
        `[dStorage/mock-chain] ownerSecret required — reference ${refId} has an ownerCommitment`,
      );
    }
    const provided = await sha256(ownerSecret);
    if (
      provided.length !== stored.length ||
      !provided.every((b, i) => b === stored[i])
    ) {
      throw new DStorageError(
        ChainErrorCode.MOCK_OWNER_SECRET_MISMATCH,
        `[dStorage/mock-chain] ownerSecret mismatch for refId: ${refId}`,
      );
    }
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
}
