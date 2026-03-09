import * as DataRegistry from "../contracts/dataregistry/managed/contract/index.js";

import {
  type ContractAddress,
  convertFieldToBytes,
} from "@midnight-ntwrk/compact-runtime";
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
  CompiledDataRegistryContractContract,
  createDataRegistryPrivateState,
  DataRegistryPrivateState,
} from "../contracts/src/index";
import {
  deployContract,
  findDeployedContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { combineLatest, map, tap, from, type Observable } from "rxjs";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";

/** @internal */

/**
 * An API for a deployed DataRegistry.
 */
export interface DeployedDataRegistryAPI {
  readonly deployedContractAddress: ContractAddress;
  readonly state$: Observable<DataRegistryDerivedState>;

  storeReference: (
    storageId: Uint8Array,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
  ) => Promise<{ refId: Uint8Array; txHash: string; blockHeight: number }>;
}

/**
 * Provides an implementation of {@link DeployedDataRegistryAPI} by adapting a deployed DataRegistry
 * contract.
 */
export class DataRegistryAPI implements DeployedDataRegistryAPI {
  /** @internal */
  private constructor(
    public readonly deployedContract: DeployedDataRegistryContract,
    providers: DataRegistryProviders,
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
      (ledgerState, privateState) => {
        /*const hashedSecretKey = DataRegistry.pureCircuits.publicKey(
          privateState.secretKey,
          convertFieldToBytes(32, ledgerState.refCounter, 'api/src/index.ts'),
        );*/

        const references = new Map<string, ReferenceEntry>();
        for (const [id, refEntry] of ledgerState.references) {
          const refId = toHex(id);
          references.set(refId, refEntry);
        }

        return {
          references,
          refCounter: ledgerState.refCounter,
          owner: toHex(ledgerState.owner),
          isOwner: false, //toHex(ledgerState.owner) === toHex(hashedSecretKey),
        };
      },
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
    storageId: Uint8Array,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
  ): Promise<{ refId: Uint8Array; txHash: string; blockHeight: number }> {
    this.logger?.log(
      "dStorage/midnight",
      `storing reference: ${toHex(storageId)}`,
    );
    if (storageId.length !== 60) {
      throw new Error(
        `Storage Id is not 60 bytes long but instead ${storageId.length}`,
      );
    }
    const txData = await this.deployedContract.callTx.storeReference(
      storageId,
      storageProvider,
      dataLabel,
      writtenAt,
    );

    const txHash: string =
      (txData as any).public?.txHash ?? (txData as any).public?.txId ?? "";
    const blockHeight: number = Number(
      (txData as any).public?.blockHeight ?? 0,
    );
    // Try to extract the circuit-computed refId (Bytes<32> return value from storeReference).
    // Falls back to an empty 32-byte array if the runtime doesn't expose private results.
    const circuitResult = (txData as any).private?.result;
    const refId: Uint8Array =
      circuitResult instanceof Uint8Array ? circuitResult : new Uint8Array(32);

    this.logger?.debug?.(
      "dStorage/midnight",
      `transaction: circuit=storeReference txHash=${txHash} blockHeight=${blockHeight}`,
    );

    return { refId, txHash, blockHeight };
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

    const deployedDataRegistryContract = await deployContract(providers, {
      compiledContract: CompiledDataRegistryContractContract,
      privateStateId: dataRegistryPrivateStateKey,
      initialPrivateState: await DataRegistryAPI.getPrivateState(providers),
    });

    logger?.debug?.(
      "dStorage/midnight",
      `DataRegistry deployed at: ${deployedDataRegistryContract.deployTxData.public.contractAddress}`,
    );

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

    const deployedDataRegistryContract =
      await findDeployedContract<DataRegistryContract>(providers, {
        contractAddress,
        compiledContract: CompiledDataRegistryContractContract,
        privateStateId: dataRegistryPrivateStateKey,
        initialPrivateState: await DataRegistryAPI.getPrivateState(providers),
      });

    logger?.debug?.(
      "dStorage/midnight",
      `DataRegistry joined at: ${deployedDataRegistryContract.deployTxData.public.contractAddress}`,
    );

    return new DataRegistryAPI(deployedDataRegistryContract, providers, logger);
  }

  private static async getPrivateState(
    providers: DataRegistryProviders,
  ): Promise<DataRegistryPrivateState> {
    const existingPrivateState = await providers.privateStateProvider.get(
      dataRegistryPrivateStateKey,
    );
    return (
      existingPrivateState ?? createDataRegistryPrivateState(randomBytes(32))
    );
  }
}

export const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

export * from "./common-types.js";
