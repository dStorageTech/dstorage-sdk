import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { Contract } from "../dataregistry/managed/contract/index.js";

export * from "../dataregistry/managed/contract/index.js";

export const witnesses = {};

export type DataRegistryPrivateState = null;

export const createDataRegistryPrivateState = () => null;

export const CompiledDataRegistryContract = CompiledContract.make<
  Contract<DataRegistryPrivateState>
>("DataRegistry", Contract<DataRegistryPrivateState>).pipe(
  CompiledContract.withVacantWitnesses,
);
