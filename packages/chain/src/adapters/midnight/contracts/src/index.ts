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
 * ownerSecret and newOwnerSecret are set transiently by the SDK before each proof-generating
 * circuit call and cleared immediately after.
 * ownerSecret is derived as HKDF-SHA256(dek, rawStorageId) for the CURRENT ref state.
 * newOwnerSecret is only used during updateReference when content changes produce a new DEK.
 */
export type DataRegistryPrivateState = {
  ownerSecret?: Uint8Array;
  newOwnerSecret?: Uint8Array;
};

/**
 * Witness implementations: read secrets placed in private state by the SDK before proof generation.
 * Both witnesses throw when their field is absent — the SDK must always set them before proof generation.
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
    return [privateState, privateState.ownerSecret];
  },
  newOwnerSecret: (
    context: WitnessContext<Ledger, DataRegistryPrivateState>,
  ): [DataRegistryPrivateState, Uint8Array] => {
    const privateState = context.privateState as DataRegistryPrivateState;
    if (!privateState.newOwnerSecret) {
      throw new Error(
        "[dStorage/midnight] newOwnerSecret is not set in private state. " +
          "The SDK must call privateStateProvider.set() with newOwnerSecret before proof generation.",
      );
    }
    return [privateState, privateState.newOwnerSecret];
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
