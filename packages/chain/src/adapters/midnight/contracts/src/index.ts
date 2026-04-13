import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Witnesses,
  type Ledger,
} from "../dataregistry/managed/contract/index.js";

export * from "../dataregistry/managed/contract/index.js";

/**
 * Private state for the DataRegistry contract.
 * ownerSecret is set transiently by the SDK before each proof-generating circuit call
 * (storeReference, removeReference, updateReference) and cleared immediately after.
 * It is derived by the SDK as: HKDF-SHA256(dek, rawStorageId).
 */
export type DataRegistryPrivateState = {
  ownerSecret?: Uint8Array;
};

/**
 * Witness implementation: reads the ownerSecret placed in private state by the SDK.
 * The contract calls ownerSecret() during proof generation to obtain the private input.
 * Throws if the SDK forgot to set it — this is a programming error, not a user error.
 */
export const witnesses: Witnesses<DataRegistryPrivateState> = {
  ownerSecret: (
    context: WitnessContext<Ledger, DataRegistryPrivateState>,
  ): [DataRegistryPrivateState, Uint8Array] => {
    const privateState = context.privateState as DataRegistryPrivateState;
    if (!privateState.ownerSecret) {
      throw new Error(
        "[dStorage/midnight] ownerSecret is not set in private state. " +
          "The SDK must call privateStateProvider.set() with ownerSecret before proof generation.",
      );
    }
    // Return the private state unchanged alongside the ownerSecret bytes.
    return [privateState, privateState.ownerSecret];
  },
};

export const createDataRegistryPrivateState =
  (): DataRegistryPrivateState => ({});

export const CompiledDataRegistryContract = CompiledContract.make<
  Contract<DataRegistryPrivateState, Witnesses<DataRegistryPrivateState>>
>(
  "DataRegistry",
  Contract<DataRegistryPrivateState, Witnesses<DataRegistryPrivateState>>,
).pipe(CompiledContract.withWitnesses(witnesses));
