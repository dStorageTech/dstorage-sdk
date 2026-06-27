/**
 * @dstorage/chain — adapters/midnightSimulator.ts
 *
 * Midnight chain adapter backed by DataRegistrySimulator — runs the real
 * DataRegistry Compact circuits in-process without requiring a live network,
 * proof server, indexer, or wallet.
 *
 * Ownership is enforced by the real circuit (ownerSecret/ownerCommitment).
 * RefIds are circuit-derived (not random UUIDs). State is per-instance (no
 * shared module-level Map).
 *
 * ⚠️  Not for production: not decentralised, not immutable.
 *     Replace with the real MidnightChainAdapter for production use.
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
import type { EncryptionScheme } from "../types.js";
import { ManagedPaymentAdapter, MockPaymentAdapter } from "@dstorage/payment";
import type { PaymentAdapter } from "@dstorage/payment";
import { DStorageError, hexToBytes } from "@dstorage/crypto";
import { ChainErrorCode } from "../errors.js";
import type { DataRegistrySimulator } from "./midnight/contracts/src/test/dataregistry-simulator.js";

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class MidnightSimulatorChainAdapter implements ChainAdapter {
  readonly name: ChainProviderName = "midnight";
  readonly providerName: string = "Midnight-Simulator";
  readonly paymentAdapter: PaymentAdapter;

  private readonly senderPk: string;
  private simulatorPromise: Promise<DataRegistrySimulator> | undefined;
  private readonly logger: ChainAdapterLogger | undefined;
  private blockHeight = 1_000_000 + Math.floor(Math.random() * 10_000);

  constructor(
    options: {
      /**
       * Sender public key passed to the DataRegistrySimulator.
       * Affects Zswap local state only — does not influence DataRegistry circuit
       * ownership (which is controlled by ownerSecret).
       * Defaults to a fixed all-zeros test key.
       */
      senderPk?: string;
      logger?: ChainAdapterLogger;
    } & (
      | { signingServerUrl: string; authToken: string }
      | { signingServerUrl?: never; authToken?: never }
    ) = {},
  ) {
    this.logger = options.logger;
    this.senderPk = options.senderPk ?? "00".repeat(32);

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
  }

  private async getSimulator(): Promise<DataRegistrySimulator> {
    if (!this.simulatorPromise) {
      this.simulatorPromise =
        import("./midnight/contracts/src/test/dataregistry-simulator.js").then(
          ({ DataRegistrySimulator }) =>
            new DataRegistrySimulator(this.senderPk),
        );
    }
    return this.simulatorPromise;
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
    if (!ref.keyEnvelope) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_KEYENVELOPE_REQUIRED,
        "[dStorage] keyEnvelope is required for all references",
      );
    }
    if (!ref.ownerSecret) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_WRITE,
        "[dStorage/midnight] ownerSecret is required for writeReference. " +
          "The core SDK must derive ownerSecret = HKDF(dek, rawStorageId) before calling writeReference.",
      );
    }

    let paymentReceipt;
    if (this.paymentAdapter) {
      this.logger?.log(
        "dStorage/midnight-simulator",
        "Sending request to balance Tx to remote service…",
      );
      paymentReceipt = await this.paymentAdapter.pay({
        network: this.name,
        dataSizeBytes: 0,
        expiresAt: Date.now() + 60_000,
      });
    }

    const contentHashBytes = ref.contentHash
      ? hexToBytes(ref.contentHash, "contentHash")
      : new Uint8Array(32);

    const sim = await this.getSimulator();
    const refIdBytes = sim.storeReference(
      ref.storageId ?? "",
      ref.encryptionScheme ?? "",
      ref.storageProvider,
      ref.encryptedMetadata ?? "",
      BigInt(ref.writtenAt),
      ref.keyEnvelope,
      contentHashBytes,
      ref.ownerSecret,
    );

    const refId = uint8ArrayToHex(refIdBytes);
    this.blockHeight += 1;

    this.logger?.log(
      "dStorage/midnight-simulator",
      `Reference written at block ${this.blockHeight} → refId: ${refId}`,
    );
    this.logger?.log(
      "dStorage/midnight-simulator",
      "⚠️  Reference is NOT written on the real Midnight network.",
    );

    return {
      refId,
      provider: this.name,
      blockHeight: this.blockHeight,
      writtenAt: ref.writtenAt,
      ...(paymentReceipt ? { paymentReceipt } : {}),
    };
  }

  async readReference(refId: string): Promise<ChainReference> {
    const refIdBytes = hexToBytes(refId, "refId");
    const sim = await this.getSimulator();
    const l = sim.getLedger();
    if (!l.references.member(refIdBytes)) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
        `[dStorage/midnight] No reference found for refId: ${refId}`,
      );
    }

    const e = l.references.lookup(refIdBytes);
    const hasHash = e.contentHash.some((b) => b !== 0);

    return {
      storageId: e.storageId,
      encryptionScheme: e.encryptionScheme as EncryptionScheme,
      storageProvider: e.storageProvider,
      ...(e.metadata ? { encryptedMetadata: e.metadata } : {}),
      writtenAt: Number(e.writtenAt),
      keyEnvelope: e.keyEnvelope ?? "",
      ...(hasHash ? { contentHash: uint8ArrayToHex(e.contentHash) } : {}),
    };
  }

  async listReferences(): Promise<DataReferenceSummary[]> {
    const result: DataReferenceSummary[] = [];
    const sim = await this.getSimulator();
    for (const [refIdBytes, e] of sim.getLedger().references) {
      result.push({
        refId: uint8ArrayToHex(refIdBytes),
        storageId: e.storageId || null,
        storageProvider: e.storageProvider,
        encryptionScheme: (e.encryptionScheme as EncryptionScheme) || null,
        keyEnvelope: e.keyEnvelope ?? "",
        ownerCommitment: uint8ArrayToHex(e.ownerCommitment),
        ...(e.metadata ? { encryptedMetadata: e.metadata } : {}),
      });
    }
    return result.sort((a, b) => a.refId.localeCompare(b.refId));
  }

  async removeReference(
    refId: string,
    ownerSecret?: Uint8Array,
  ): Promise<void> {
    const refIdBytes = hexToBytes(refId, "refId");
    const sim = await this.getSimulator();

    if (!sim.getLedger().references.member(refIdBytes)) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
        `[dStorage/midnight] No reference found for refId: ${refId}`,
      );
    }
    if (!ownerSecret) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_REMOVE,
        "[dStorage/midnight] ownerSecret is required for removeReference. " +
          "The core SDK must derive ownerSecret = HKDF(dek, rawStorageId) before calling removeReference.",
      );
    }

    this.logger?.log(
      "dStorage/midnight-simulator",
      `removeReference → refId: ${refId}`,
    );
    sim.removeReference(refIdBytes, ownerSecret);
  }

  async updateReference(
    refId: string,
    update: ChainReferenceUpdate,
    ownerSecret?: Uint8Array,
    newOwnerSecret?: Uint8Array,
  ): Promise<void> {
    const refIdBytes = hexToBytes(refId, "refId");
    const sim = await this.getSimulator();

    if (!sim.getLedger().references.member(refIdBytes)) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_REF_NOT_FOUND,
        `[dStorage/midnight] No reference found for refId: ${refId}`,
      );
    }
    if (!ownerSecret) {
      throw new DStorageError(
        ChainErrorCode.MIDNIGHT_OWNER_SECRET_REQUIRED_UPDATE,
        "[dStorage/midnight] ownerSecret is required for updateReference. " +
          "The core SDK must derive ownerSecret = HKDF(dek, rawStorageId) before calling updateReference.",
      );
    }

    const contentHashBytes = update.contentHash
      ? hexToBytes(update.contentHash, "contentHash")
      : new Uint8Array(32);

    this.logger?.log(
      "dStorage/midnight-simulator",
      `updateReference → refId: ${refId}`,
    );
    sim.updateReference(
      refIdBytes,
      update.storageId,
      update.encryptionScheme,
      update.storageProvider,
      update.encryptedMetadata ?? "",
      BigInt(update.writtenAt),
      update.keyEnvelope,
      contentHashBytes,
      ownerSecret,
      newOwnerSecret,
    );
  }

  // ── DataRegistry deployment stubs ─────────────────────────────────────────

  setContractAddress(_address: string): void {
    // No-op for mock — contract address is not used
  }

  getContractAddress(): string {
    return "midnight-simulator-contract-address";
  }

  async deployDataRegistry(): Promise<string> {
    const addr = `mock_contract_${Date.now()}`;
    this.logger?.log(
      "dStorage/midnight-simulator",
      `DataRegistry deployed at: ${addr}`,
    );
    return addr;
  }
}
