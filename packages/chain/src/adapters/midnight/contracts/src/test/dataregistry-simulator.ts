import {
  type CircuitContext,
  type CircuitResults,
  type ChargedState,
  type StateValue,
  sampleContractAddress,
  createConstructorContext,
  createCircuitContext,
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

type DataRegistryCircuitId =
  keyof Contract<DataRegistryPrivateState>["impureCircuits"];

/**
 * Serves as a testbed to exercise the DataRegistry contract in tests.
 *
 * Circuits run asynchronously, so build an instance with {@link DataRegistrySimulator.create}.
 */
export class DataRegistrySimulator {
  readonly contract: Contract<DataRegistryPrivateState>;
  readonly contractAddress: ContractAddress;
  currentPk: string;
  /** On-chain state of the simulated contract, updated after every circuit call. */
  private contractState: StateValue | ChargedState;
  /** Default ownerSecret used when no secret is passed to circuit methods. Refreshed on switchUser(). */
  private _defaultOwnerSecret: Uint8Array = crypto.getRandomValues(
    new Uint8Array(32),
  );

  private constructor(
    contract: Contract<DataRegistryPrivateState>,
    contractState: StateValue | ChargedState,
    senderPk: string,
  ) {
    this.contractAddress = sampleContractAddress();
    this.contract = contract;
    this.contractState = contractState;
    this.currentPk = senderPk;
  }

  static async create(senderPk: string): Promise<DataRegistrySimulator> {
    const contract = new Contract<DataRegistryPrivateState>(witnesses);
    const { currentContractState } = await contract.initialState(
      createConstructorContext(createDataRegistryPrivateState(), senderPk),
    );
    return new DataRegistrySimulator(
      contract,
      currentContractState.data,
      senderPk,
    );
  }

  /**
   * Switch to a different user (different secret key and public key).
   * Generates a fresh random default owner secret for the new user.
   */
  public switchUser(senderPk: string): void {
    this.currentPk = senderPk;
    this._defaultOwnerSecret = crypto.getRandomValues(new Uint8Array(32));
  }

  public getLedger(): Ledger {
    return ledger(this.contractState);
  }

  /**
   * A circuit context for calling `circuitId` as the current user, against the
   * current contract state, with the given private state.
   */
  public contextFor(
    circuitId: DataRegistryCircuitId,
    privateState: DataRegistryPrivateState,
  ): CircuitContext<DataRegistryPrivateState> {
    return createCircuitContext({
      circuitId,
      contractAddress: this.contractAddress,
      coinPublicKeyOrZswapState: this.currentPk,
      contractState: this.contractState,
      privateState,
      costModel: CostModel.initialCostModel(),
    });
  }

  /** Run a circuit and keep the contract state it leaves behind. */
  private async run<R>(
    circuitId: DataRegistryCircuitId,
    privateState: DataRegistryPrivateState,
    call: (
      context: CircuitContext<DataRegistryPrivateState>,
    ) => Promise<CircuitResults<DataRegistryPrivateState, R>>,
  ): Promise<R> {
    const res = await call(this.contextFor(circuitId, privateState));
    this.contractState = res.context.callContext.currentQueryContext.state;
    return res.result;
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
  ): Promise<Uint8Array> {
    return this.run("storeReference", { ownerSecret }, (context) =>
      this.contract.impureCircuits.storeReference(
        context,
        storageId,
        encryptionScheme,
        storageProvider,
        metadata,
        writtenAt,
        keyEnvelope,
        contentHash,
      ),
    );
  }

  public removeReference(
    refId: Uint8Array,
    ownerSecret: Uint8Array = this._defaultOwnerSecret,
  ): Promise<[]> {
    return this.run("removeReference", { ownerSecret }, (context) =>
      this.contract.impureCircuits.removeReference(context, refId),
    );
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
  ): Promise<[]> {
    return this.run(
      "updateReference",
      { ownerSecret, newOwnerSecret: newOwnerSecret ?? ownerSecret },
      (context) =>
        this.contract.impureCircuits.updateReference(
          context,
          refId,
          storageId,
          encryptionScheme,
          storageProvider,
          metadata,
          writtenAt,
          keyEnvelope,
          contentHash,
        ),
    );
  }
}
