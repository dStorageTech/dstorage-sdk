import {
  type MidnightProviders,
  type MidnightProvider,
  type WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk/facade";
import { type FoundContract } from "@midnight-ntwrk/midnight-js-contracts";
import type {
  DataRegistryPrivateState,
  ReferenceEntry,
  Contract,
  Witnesses,
} from "../contracts/src/index";

/**
 * Minimal interface the adapter requires from a wallet provider passed via
 * walletMode: "provider". Any object implementing WalletProvider and
 * MidnightProvider with an accessible WalletFacade satisfies this.
 */
export interface AdapterWalletProvider
  extends WalletProvider, MidnightProvider {
  readonly wallet: WalletFacade;
}

export const dataRegistryPrivateStateKey = "DataRegistryPrivateState";
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
export type DataRegistryContract = Contract<
  DataRegistryPrivateState,
  Witnesses<DataRegistryPrivateState>
>;

/**
 * The keys of the circuits exported from {@link DataRegistryContract}.
 *
 * @public
 */
export type DataRegistryCircuitKeys = Exclude<
  keyof DataRegistryContract["impureCircuits"],
  number | symbol
>;

/**
 * The providers required by {@link DataRegistryContract}.
 *
 * @public
 */
export type DataRegistryProviders = MidnightProviders<
  DataRegistryCircuitKeys,
  PrivateStateId,
  DataRegistryPrivateState
>;

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
  readonly references: Map<string, ReferenceEntry>;
  readonly refCounter: bigint;
  /** Schema version of the deployed contract. Used by the SDK to verify compatibility. */
  readonly contractVersion: bigint;
};
