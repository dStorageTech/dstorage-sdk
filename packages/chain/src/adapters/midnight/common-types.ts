import { type MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { type FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { DataRegistryPrivateState, ReferenceEntry, Contract, Witnesses } from './contracts/src/index';

export const dataRegistryPrivateStateKey = 'DataRegistryPrivateState';
export type PrivateStateId = typeof dataRegistryPrivateStateKey;

/**
 * The private states consumed throughout the application.
 */
export type PrivateStates = {
  /**
   * Key used to provide the private state for {@link DataRegistryContract} deployments.
   */
  readonly DataRegistryPrivateState: DataRegistryPrivateState;
};

/**
 * Represents DataRegistry contract and its private state.
 *
 * @public
 */
export type DataRegistryContract = Contract<DataRegistryPrivateState, Witnesses<DataRegistryPrivateState>>;

/**
 * The keys of the circuits exported from {@link DataRegistryContract}.
 *
 * @public
 */
export type DataRegistryCircuitKeys = Exclude<keyof DataRegistryContract['impureCircuits'], number | symbol>;

/**
 * The providers required by {@link DataRegistryContract}.
 *
 * @public
 */
export type DataRegistryProviders = MidnightProviders<DataRegistryCircuitKeys, PrivateStateId, DataRegistryPrivateState>;

/**
 * A {@link DataRegistryContract} that has been deployed to the network.
 *
 * @public
 */
export type DeployedDataRegistryContract = FoundContract<DataRegistryContract>;

/**
 * A type that represents the derived combination of public (or ledger), and private state.
 */
export type DataRegistryDerivedState = {
  readonly references: Map<string, ReferenceEntry> ;
  readonly refCounter: bigint;
  readonly owner: string;

  /**
   * A readonly flag that determines if the current message was posted by the current user.
   *
   * @remarks
   * The `owner` property of the public (or ledger) state is the public key of the message owner, while
   * the `secretKey` property of {@link DataRegistryPrivateState} is the secret key of the current user. If
   * `owner` corresponds to the public key derived from `secretKey`, then `isOwner` is `true`.
   */
  readonly isOwner: boolean;
};
