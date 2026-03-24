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
} from "../witnesses.js";

/**
 * Serves as a testbed to exercise the DataRegistry contract in tests.
 */
export class DataRegistrySimulator {
  readonly contract: Contract<DataRegistryPrivateState>;
  readonly contractAddress: ContractAddress;
  circuitContext: CircuitContext<DataRegistryPrivateState>;

  constructor(secretKey: Uint8Array, senderPk: string) {
    this.contractAddress = sampleContractAddress();
    this.contract = new Contract<DataRegistryPrivateState>(witnesses);
    const {
      currentPrivateState,
      currentContractState,
      currentZswapLocalState,
    } = this.contract.initialState(
      createConstructorContext(
        createDataRegistryPrivateState(secretKey),
        senderPk,
      ),
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
  public switchUser(secretKey: Uint8Array, senderPk: string): void {
    this.circuitContext.currentZswapLocalState = emptyZswapLocalState(senderPk);
    this.circuitContext.currentPrivateState =
      createDataRegistryPrivateState(secretKey);
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
  ): Uint8Array {
    const res = this.contract.impureCircuits.storeReference(
      this.circuitContext,
      storageId,
      encryptionScheme,
      storageProvider,
      dataLabel,
      writtenAt,
    );
    this.circuitContext = res.context;
    return res.result;
  }

  public removeReference(refId: Uint8Array): [] {
    const res = this.contract.impureCircuits.removeReference(
      this.circuitContext,
      refId,
    );
    this.circuitContext = res.context;
    return res.result;
  }

  public updateReference(
    refId: Uint8Array,
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    dataLabel: string,
    writtenAt: bigint,
  ): [] {
    const res = this.contract.impureCircuits.updateReference(
      this.circuitContext,
      refId,
      storageId,
      encryptionScheme,
      storageProvider,
      dataLabel,
      writtenAt,
    );
    this.circuitContext = res.context;
    return res.result;
  }
}
