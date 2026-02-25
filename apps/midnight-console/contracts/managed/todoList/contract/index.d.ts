import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type NoteEntry = { storageId: Uint8Array;
                          storageProvider: Uint8Array;
                          owner: Uint8Array;
                          dataLabel: Uint8Array;
                          createdAt: bigint
                        };

export type Witnesses<PS> = {
  deriveNoteId(context: __compactRuntime.WitnessContext<Ledger, PS>,
               storageId_0: Uint8Array,
               count_0: bigint): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  storeReference(context: __compactRuntime.CircuitContext<PS>,
                 storageId_0: Uint8Array,
                 storageProvider_0: Uint8Array,
                 owner_0: Uint8Array,
                 dataLabel_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  getReference(context: __compactRuntime.CircuitContext<PS>, refId_0: Uint8Array): __compactRuntime.CircuitResults<PS, NoteEntry>;
  grantAccess(context: __compactRuntime.CircuitContext<PS>,
              refId_0: Uint8Array,
              grantee_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revokeAccess(context: __compactRuntime.CircuitContext<PS>,
               refId_0: Uint8Array,
               grantee_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  hasAccess(context: __compactRuntime.CircuitContext<PS>,
            refId_0: Uint8Array,
            wallet_0: Uint8Array): __compactRuntime.CircuitResults<PS, boolean>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  storeReference(context: __compactRuntime.CircuitContext<PS>,
                 storageId_0: Uint8Array,
                 storageProvider_0: Uint8Array,
                 owner_0: Uint8Array,
                 dataLabel_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  getReference(context: __compactRuntime.CircuitContext<PS>, refId_0: Uint8Array): __compactRuntime.CircuitResults<PS, NoteEntry>;
  grantAccess(context: __compactRuntime.CircuitContext<PS>,
              refId_0: Uint8Array,
              grantee_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revokeAccess(context: __compactRuntime.CircuitContext<PS>,
               refId_0: Uint8Array,
               grantee_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  hasAccess(context: __compactRuntime.CircuitContext<PS>,
            refId_0: Uint8Array,
            wallet_0: Uint8Array): __compactRuntime.CircuitResults<PS, boolean>;
}

export type Ledger = {
  notes: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): NoteEntry;
    [Symbol.iterator](): Iterator<[Uint8Array, NoteEntry]>
  };
  readonly noteCounter: bigint;
  permissions: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<[Uint8Array, boolean]>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
