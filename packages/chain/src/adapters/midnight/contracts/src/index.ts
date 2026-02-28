import { CompiledContract } from "@midnight-ntwrk/compact-js";
export * from "../managed/contract/index.js";
export * from "./witnesses.js";

import * as CompiledDataRegistryContract from "../managed/contract/index.js";
import * as Witnesses from "./witnesses.js";

export const CompiledDataRegistryContractContract = CompiledContract.make<
  CompiledDataRegistryContract.Contract<Witnesses.DataRegistryPrivateState>
>(
  "Counter",
  CompiledDataRegistryContract.Contract<Witnesses.DataRegistryPrivateState>,
).pipe(
  CompiledContract.withWitnesses(Witnesses.witnesses),
  CompiledContract.withCompiledFileAssets("./compiled/counter"),
);
