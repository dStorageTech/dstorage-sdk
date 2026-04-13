import {
  type CircuitContext,
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  emptyZswapLocalState,
  ContractAddress,
  CostModel,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger,
} from "../../dataregistry/managed/contract/index.js";
import {
  type DataRegistryPrivateState,
  witnesses,
  createDataRegistryPrivateState,
} from "../index.js";

/**
 * Serves as a testbed to exercise the DataRegistry contract in tests.
 */
export class DataRegistrySimulator {
  readonly contract: Contract<DataRegistryPrivateState>;
  readonly contractAddress: ContractAddress;
  circuitContext: CircuitContext<DataRegistryPrivateState>;
  currentPk: string;

  constructor(senderPk: string) {
    this.contractAddress = sampleContractAddress();
    this.contract = new Contract<DataRegistryPrivateState>(witnesses);
    this.currentPk = senderPk;
    const {
      currentPrivateState,
      currentContractState,
      currentZswapLocalState,
    } = this.contract.initialState(
      createConstructorContext(createDataRegistryPrivateState(), senderPk),
    );
    this.circuitContext = {
      currentPrivateState,
      currentZswapLocalState,
      costModel: CostModel.initialCostModel(),
      currentQueryContext: new QueryContext(
        currentContractState.data,
        this.contractAddress,
      ),
    };
  }

  /**
   * Switch to a different user (different secret key and public key).
   */
  public switchUser(senderPk: string): void {
    this.currentPk = senderPk;
    this.circuitContext.currentZswapLocalState = emptyZswapLocalState(senderPk);
    this.circuitContext.currentPrivateState = createDataRegistryPrivateState();
  }

  public getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  public storeReference(
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
    keyEnvelope: string = "",
    ownerSecret: Uint8Array = new Uint8Array(32),
  ): Uint8Array {
    this.circuitContext.currentPrivateState = { ownerSecret };
    const res = this.contract.impureCircuits.storeReference(
      this.circuitContext,
      storageId,
      encryptionScheme,
      storageProvider,
      dataLabel,
      writtenAt,
      keyEnvelope,
    );
    this.circuitContext = { ...res.context, currentPrivateState: {} };
    return res.result;
  }

  public removeReference(
    refId: Uint8Array,
    ownerSecret: Uint8Array = new Uint8Array(32),
  ): [] {
    this.circuitContext.currentPrivateState = { ownerSecret };
    const res = this.contract.impureCircuits.removeReference(
      this.circuitContext,
      refId,
    );
    this.circuitContext = { ...res.context, currentPrivateState: {} };
    return res.result;
  }

  public updateReference(
    refId: Uint8Array,
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
    keyEnvelope: string = "",
    ownerSecret: Uint8Array = new Uint8Array(32),
  ): [] {
    this.circuitContext.currentPrivateState = { ownerSecret };
    const res = this.contract.impureCircuits.updateReference(
      this.circuitContext,
      refId,
      storageId,
      encryptionScheme,
      storageProvider,
      dataLabel,
      writtenAt,
      keyEnvelope,
    );
    this.circuitContext = { ...res.context, currentPrivateState: {} };
    return res.result;
  }
}
