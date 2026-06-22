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
  /** Default ownerSecret used when no secret is passed to circuit methods. Refreshed on switchUser(). */
  private _defaultOwnerSecret: Uint8Array = crypto.getRandomValues(
    new Uint8Array(32),
  );

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
   * Generates a fresh random default owner secret for the new user.
   */
  public switchUser(senderPk: string): void {
    this.currentPk = senderPk;
    this.circuitContext.currentZswapLocalState = emptyZswapLocalState(senderPk);
    this.circuitContext.currentPrivateState = createDataRegistryPrivateState();
    this._defaultOwnerSecret = crypto.getRandomValues(new Uint8Array(32));
  }

  public getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  public storeReference(
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    metadata: string,
    writtenAt: bigint,
    keyEnvelope: string = "",
    contentHash: Uint8Array = new Uint8Array(32),
    ownerSecret: Uint8Array = this._defaultOwnerSecret,
  ): Uint8Array {
    this.circuitContext.currentPrivateState = { ownerSecret };
    const res = this.contract.impureCircuits.storeReference(
      this.circuitContext,
      storageId,
      encryptionScheme,
      storageProvider,
      metadata,
      writtenAt,
      keyEnvelope,
      contentHash,
    );
    this.circuitContext = { ...res.context, currentPrivateState: {} };
    return res.result;
  }

  public removeReference(
    refId: Uint8Array,
    ownerSecret: Uint8Array = this._defaultOwnerSecret,
  ): [] {
    this.circuitContext.currentPrivateState = { ownerSecret };
    const res = this.contract.impureCircuits.removeReference(
      this.circuitContext,
      refId,
    );
    this.circuitContext = { ...res.context, currentPrivateState: {} };
    return res.result;
  }

  public computeOwnerCommitment(
    secret: Uint8Array,
    nonce: Uint8Array,
    instanceSalt: Uint8Array,
  ): Uint8Array {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.contract as any)._computeOwnerCommitment_0(
      secret,
      nonce,
      instanceSalt,
    );
  }

  public updateReference(
    refId: Uint8Array,
    storageId: string,
    encryptionScheme: string,
    storageProvider: string,
    metadata: string,
    writtenAt: bigint,
    keyEnvelope: string = "",
    contentHash: Uint8Array = new Uint8Array(32),
    ownerSecret: Uint8Array = this._defaultOwnerSecret,
    newOwnerSecret?: Uint8Array,
  ): [] {
    this.circuitContext.currentPrivateState = {
      ownerSecret,
      newOwnerSecret: newOwnerSecret ?? ownerSecret,
    };
    const res = this.contract.impureCircuits.updateReference(
      this.circuitContext,
      refId,
      storageId,
      encryptionScheme,
      storageProvider,
      metadata,
      writtenAt,
      keyEnvelope,
      contentHash,
    );
    this.circuitContext = { ...res.context, currentPrivateState: {} };
    return res.result;
  }
}
