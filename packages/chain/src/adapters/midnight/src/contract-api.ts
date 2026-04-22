import * as DataRegistry from "../contracts/dataregistry/managed/contract/index.js";

import { type ContractAddress } from "@midnight-ntwrk/compact-runtime";
import type { Logger } from "../../../types.js";
import {
  type DataRegistryDerivedState,
  type DataRegistryContract,
  type DataRegistryProviders,
  type DeployedDataRegistryContract,
  dataRegistryPrivateStateKey,
} from "./common-types.js";
import {
  ReferenceEntry,
  CompiledDataRegistryContract,
  createDataRegistryPrivateState,
  DataRegistryPrivateState,
} from "../contracts/src/index";
import {
  deployContract,
  findDeployedContract,
  withContractScopedTransaction,
} from "@midnight-ntwrk/midnight-js-contracts";
import {
  combineLatest,
  map,
  tap,
  from,
  firstValueFrom,
  shareReplay,
  type Observable,
} from "rxjs";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";

/** @internal */

/**
 * The only contract schema version this SDK knows how to interpret.
 * When a future deployment bumps `contractVersion`, the SDK must be updated
 * before it can join that contract.
 */
export const SUPPORTED_CONTRACT_VERSION = 0n;

/**
 * Asserts that the on-chain `contractVersion` matches the version this SDK supports.
 * Throws a descriptive error when they differ so callers receive clear guidance
 * instead of a silent data-interpretation failure.
 */
export function validateContractVersion(
  version: bigint,
  contractAddress: string,
): void {
  if (version !== SUPPORTED_CONTRACT_VERSION) {
    throw new Error(
      `[dStorage/midnight] Unsupported contract version ${version} at ${contractAddress}. ` +
        `This SDK supports version ${SUPPORTED_CONTRACT_VERSION} only. ` +
        `Deploy a compatible DataRegistry contract or upgrade the SDK.`,
    );
  }
}

/**
 * An API for a deployed DataRegistry.
 */
export interface DeployedDataRegistryAPI {
  readonly deployedContractAddress: ContractAddress;
  readonly state$: Observable<DataRegistryDerivedState>;

  storeReference: (
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
    keyEnvelope: string,
    ownerSecret: Uint8Array,
  ) => Promise<{ refId: Uint8Array; txHash: string; blockHeight: number }>;

  removeReference: (
    refId: Uint8Array,
    ownerSecret: Uint8Array,
  ) => Promise<{ txHash: string; blockHeight: number }>;

  updateReference: (
    refId: Uint8Array,
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
    keyEnvelope: string,
    ownerSecret: Uint8Array,
  ) => Promise<{ txHash: string; blockHeight: number }>;
}

/**
 * Provides an implementation of {@link DeployedDataRegistryAPI} by adapting a deployed DataRegistry
 * contract.
 */
export class DataRegistryAPI implements DeployedDataRegistryAPI {
  /** @internal */
  private constructor(
    public readonly deployedContract: DeployedDataRegistryContract,
    private readonly providers: DataRegistryProviders,
    private readonly logger?: Logger,
  ) {
    this.deployedContractAddress =
      deployedContract.deployTxData.public.contractAddress;
    this.state$ = combineLatest(
      [
        // Combine public (ledger) state with...
        providers.publicDataProvider
          .contractStateObservable(this.deployedContractAddress, {
            type: "latest",
          })
          .pipe(
            map((contractState) => DataRegistry.ledger(contractState.data)),
            tap((ledgerState) =>
              logger?.debug?.(
                "dStorage/midnight",
                `ledger state changed: refCounter=${ledgerState.refCounter}`,
              ),
            ),
          ),
        // ...private state...
        //    since the private state of the DataRegistry application never changes, we can query the
        //    private state once and always use the same value with `combineLatest`. In applications
        //    where the private state is expected to change, we would need to make this an `Observable`.
        from(
          providers.privateStateProvider.get(
            dataRegistryPrivateStateKey,
          ) as Promise<DataRegistryPrivateState>,
        ),
      ],
      // ...and combine them to produce the required derived state.
      // isOurs is set to false here — ownership is determined by the core SDK
      // (dStorage.ts) by attempting to unwrap the DEK from the keyEnvelope using
      // the available KEKs. This avoids coupling the chain layer to key material.
      (ledgerState, _privateState) => {
        const references = new Map<string, ReferenceEntry>();
        for (const [id, refEntry] of ledgerState.references) {
          const refId = toHex(id);
          references.set(refId, refEntry);
        }

        return {
          references,
          refCounter: ledgerState.refCounter,
          contractVersion: ledgerState.contractVersion,
        };
      },
    ).pipe(
      // Keep one live subscription to the indexer WebSocket for the lifetime of
      // this API instance. Without shareReplay, each firstValueFrom(state$) call
      // creates a new subscription — the indexer does not replay the last emitted
      // state to new subscribers, so callers would receive stale data until the
      // next on-chain change arrives. shareReplay(1) ensures:
      //   1. The indexer connection is established once and kept alive.
      //   2. Every new subscriber (e.g. listReferences, readReference) immediately
      //      receives the most recently emitted state.
      //   3. Future indexer pushes (after upload/remove txs) still update the cache.
      shareReplay({ bufferSize: 1, refCount: false }),
    );
  }

  /**
   * Gets the address of the current deployed contract.
   */
  readonly deployedContractAddress: ContractAddress;

  /**
   * Gets an observable stream of state changes based on the current public (ledger),
   * and private state data.
   */
  readonly state$: Observable<DataRegistryDerivedState>;

  async storeReference(
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
    keyEnvelope: string,
    ownerSecret: Uint8Array,
  ): Promise<{ refId: Uint8Array; txHash: string; blockHeight: number }> {
    this.logger?.log(
      "dStorage/midnight",
      `storing reference: storageId=${storageId}`,
    );
    await this.providers.privateStateProvider.set(dataRegistryPrivateStateKey, {
      ownerSecret,
    });
    let txData;
    try {
      txData = await withContractScopedTransaction(
        this.providers,
        async (txCtx) => {
          await this.deployedContract.callTx.storeReference(
            txCtx,
            storageId,
            encryptionScheme,
            storageProvider,
            dataLabel,
            writtenAt,
            keyEnvelope,
          );
        },
        { scopeName: "storeReference" },
      );
    } finally {
      await this.providers.privateStateProvider.set(
        dataRegistryPrivateStateKey,
        {},
      );
    }

    const txHash: string =
      (txData as any).public?.txHash ?? (txData as any).public?.txId ?? "";
    const blockHeight: number = Number(
      (txData as any).public?.blockHeight ?? 0,
    );
    const circuitResult = (txData as any).private?.result;
    if (!(circuitResult instanceof Uint8Array)) {
      throw new Error(
        `[dStorage/midnight] storeReference succeeded on-chain (txHash=${txHash}) ` +
          `but the runtime did not return the circuit refId at txData.private.result ` +
          `(got ${typeof circuitResult}). ` +
          `This is likely a compact-runtime version mismatch. ` +
          `Upgrade @midnight-ntwrk/compact-runtime or report this as a bug.`,
      );
    }
    const refId: Uint8Array = circuitResult;

    this.logger?.debug?.(
      "dStorage/midnight",
      `transaction: circuit=storeReference txHash=${txHash} blockHeight=${blockHeight}`,
    );

    return { refId, txHash, blockHeight };
  }

  async removeReference(
    refId: Uint8Array,
    ownerSecret: Uint8Array,
  ): Promise<{ txHash: string; blockHeight: number }> {
    this.logger?.log(
      "dStorage/midnight",
      `removing reference: ${toHex(refId)}`,
    );
    await this.providers.privateStateProvider.set(dataRegistryPrivateStateKey, {
      ownerSecret,
    });
    let txData;
    try {
      txData = await withContractScopedTransaction(
        this.providers,
        async (txCtx) => {
          await this.deployedContract.callTx.removeReference(txCtx, refId);
        },
        { scopeName: "removeReference" },
      );
    } finally {
      await this.providers.privateStateProvider.set(
        dataRegistryPrivateStateKey,
        {},
      );
    }

    const txHash: string =
      (txData as any).public?.txHash ?? (txData as any).public?.txId ?? "";
    const blockHeight: number = Number(
      (txData as any).public?.blockHeight ?? 0,
    );

    this.logger?.debug?.(
      "dStorage/midnight",
      `transaction: circuit=removeReference txHash=${txHash} blockHeight=${blockHeight}`,
    );

    return { txHash, blockHeight };
  }

  async updateReference(
    refId: Uint8Array,
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
    keyEnvelope: string,
    ownerSecret: Uint8Array,
  ): Promise<{ txHash: string; blockHeight: number }> {
    this.logger?.log(
      "dStorage/midnight",
      `updating reference: ${toHex(refId)}`,
    );
    await this.providers.privateStateProvider.set(dataRegistryPrivateStateKey, {
      ownerSecret,
    });
    let txData;
    try {
      txData = await withContractScopedTransaction(
        this.providers,
        async (txCtx) => {
          await this.deployedContract.callTx.updateReference(
            txCtx,
            refId,
            storageId,
            encryptionScheme,
            storageProvider,
            dataLabel,
            writtenAt,
            keyEnvelope,
          );
        },
        { scopeName: "updateReference" },
      );
    } finally {
      await this.providers.privateStateProvider.set(
        dataRegistryPrivateStateKey,
        {},
      );
    }

    const txHash: string =
      (txData as any).public?.txHash ?? (txData as any).public?.txId ?? "";
    const blockHeight: number = Number(
      (txData as any).public?.blockHeight ?? 0,
    );

    this.logger?.debug?.(
      "dStorage/midnight",
      `transaction: circuit=updateReference txHash=${txHash} blockHeight=${blockHeight}`,
    );

    return { txHash, blockHeight };
  }

  /**
   * Deploys a new DataRegistry contract to the network.
   *
   * @param providers The DataRegistry providers.
   * @param logger An optional 'pino' logger to use for logging.
   * @returns A `Promise` that resolves with a {@link DataRegistryAPI} instance that manages the newly deployed
   * {@link DeployedDataRegistryContract}; or rejects with a deployment error.
   */
  static async deploy(
    providers: DataRegistryProviders,
    logger?: Logger,
  ): Promise<DataRegistryAPI> {
    logger?.log("dStorage/midnight", "deploying DataRegistry contract...");

    // For a fresh deployment there is no prior private state — always start clean.
    // We cannot call setContractAddress() here because the address doesn't exist yet.
    const deployedDataRegistryContract = await deployContract(providers, {
      compiledContract: CompiledDataRegistryContract,
      privateStateId: dataRegistryPrivateStateKey,
      initialPrivateState: createDataRegistryPrivateState(),
    });

    return new DataRegistryAPI(deployedDataRegistryContract, providers, logger);
  }

  /**
   * Finds an already deployed DataRegistry contract on the network, and joins it.
   *
   * @param providers The DataRegistry providers.
   * @param contractAddress The contract address of the deployed DataRegistry contract to search for and join.
   * @param logger An optional 'pino' logger to use for logging.
   * @returns A `Promise` that resolves with a {@link DataRegistryAPI} instance that manages the joined
   * {@link DeployedDataRegistryContract}; or rejects with an error.
   */
  static async join(
    providers: DataRegistryProviders,
    contractAddress: ContractAddress,
    logger?: Logger,
  ): Promise<DataRegistryAPI> {
    logger?.log(
      "dStorage/midnight",
      `joining DataRegistry contract at: ${contractAddress}`,
    );

    // Set the contract address on the private state provider BEFORE calling get(),
    // because levelPrivateStateProvider requires it to be set before any access.
    // findDeployedContract() will also call setContractAddress() internally, but by
    // then getPrivateState() below would have already thrown without this pre-call.
    providers.privateStateProvider.setContractAddress(contractAddress);

    const deployedDataRegistryContract =
      await findDeployedContract<DataRegistryContract>(providers, {
        contractAddress,
        compiledContract: CompiledDataRegistryContract,
        privateStateId: dataRegistryPrivateStateKey,
        initialPrivateState: await DataRegistryAPI.getPrivateState(providers),
      });

    // Validate the on-chain contract version before accepting the contract.
    const contractVersion = await firstValueFrom(
      providers.publicDataProvider
        .contractStateObservable(contractAddress, { type: "latest" })
        .pipe(map((s) => DataRegistry.ledger(s.data).contractVersion)),
    );
    validateContractVersion(contractVersion, contractAddress);

    return new DataRegistryAPI(deployedDataRegistryContract, providers, logger);
  }

  private static async getPrivateState(
    providers: DataRegistryProviders,
  ): Promise<DataRegistryPrivateState> {
    const existingPrivateState = await providers.privateStateProvider.get(
      dataRegistryPrivateStateKey,
    );
    return existingPrivateState ?? createDataRegistryPrivateState();
  }
}

export const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

export * from "./common-types.js";
