import { Ledger } from "../managed/contract/index.js";
import { WitnessContext } from "@midnight-ntwrk/compact-runtime";

export type DataRegistryPrivateState = {
  readonly secretKey: Uint8Array;
};

export const createDataRegistryPrivateState = (secretKey: Uint8Array) => ({
  secretKey,
});

export const witnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, DataRegistryPrivateState>): [
    DataRegistryPrivateState,
    Uint8Array,
  ] => [privateState, privateState.secretKey],
};
