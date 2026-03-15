import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ReferenceEntry = { storageId: string;
                               encryptionScheme: string;
                               storageProvider: string;
                               dataLabel: string;
                               writtenAt: bigint
                             };

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  storeReference(context: __compactRuntime.CircuitContext<PS>,
                 storageId_0: string,
                 encryptionScheme_0: string,
                 storageProvider_0: string,
                 dataLabel_0: string,
                 writtenAt_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type PureCircuits = {
  deriveRefId(refCounter_0: Uint8Array, instanceSalt_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  deriveRefId(context: __compactRuntime.CircuitContext<PS>,
              refCounter_0: Uint8Array,
              instanceSalt_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  storeReference(context: __compactRuntime.CircuitContext<PS>,
                 storageId_0: string,
                 encryptionScheme_0: string,
                 storageProvider_0: string,
                 dataLabel_0: string,
                 writtenAt_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type Ledger = {
  references: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): ReferenceEntry;
    [Symbol.iterator](): Iterator<[Uint8Array, ReferenceEntry]>
  };
  readonly refCounter: bigint;
  readonly contractVersion: bigint;
  readonly owner: Uint8Array;
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
