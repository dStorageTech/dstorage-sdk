import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ReferenceEntry = { storageId: string;
                               encryptionScheme: string;
                               storageProvider: string;
                               metadata: string;
                               writtenAt: bigint;
                               keyEnvelope: string;
                               ownerCommitment: Uint8Array;
                               contentHash: Uint8Array
                             };

export type Witnesses<PS> = {
  ownerSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  newOwnerSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  storeReference(context: __compactRuntime.CircuitContext<PS>,
                 storageId_0: string,
                 encryptionScheme_0: string,
                 storageProvider_0: string,
                 metadata_0: string,
                 writtenAt_0: bigint,
                 keyEnvelope_0: string,
                 contentHash_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  removeReference(context: __compactRuntime.CircuitContext<PS>,
                  refId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  updateReference(context: __compactRuntime.CircuitContext<PS>,
                  refId_0: Uint8Array,
                  storageId_0: string,
                  encryptionScheme_0: string,
                  storageProvider_0: string,
                  metadata_0: string,
                  writtenAt_0: bigint,
                  keyEnvelope_0: string,
                  contentHash_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  storeReference(context: __compactRuntime.CircuitContext<PS>,
                 storageId_0: string,
                 encryptionScheme_0: string,
                 storageProvider_0: string,
                 metadata_0: string,
                 writtenAt_0: bigint,
                 keyEnvelope_0: string,
                 contentHash_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  removeReference(context: __compactRuntime.CircuitContext<PS>,
                  refId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  updateReference(context: __compactRuntime.CircuitContext<PS>,
                  refId_0: Uint8Array,
                  storageId_0: string,
                  encryptionScheme_0: string,
                  storageProvider_0: string,
                  metadata_0: string,
                  writtenAt_0: bigint,
                  keyEnvelope_0: string,
                  contentHash_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
  deriveRefId(refCounter_0: Uint8Array, instanceSalt_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  deriveRefId(context: __compactRuntime.CircuitContext<PS>,
              refCounter_0: Uint8Array,
              instanceSalt_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  storeReference(context: __compactRuntime.CircuitContext<PS>,
                 storageId_0: string,
                 encryptionScheme_0: string,
                 storageProvider_0: string,
                 metadata_0: string,
                 writtenAt_0: bigint,
                 keyEnvelope_0: string,
                 contentHash_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  removeReference(context: __compactRuntime.CircuitContext<PS>,
                  refId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  updateReference(context: __compactRuntime.CircuitContext<PS>,
                  refId_0: Uint8Array,
                  storageId_0: string,
                  encryptionScheme_0: string,
                  storageProvider_0: string,
                  metadata_0: string,
                  writtenAt_0: bigint,
                  keyEnvelope_0: string,
                  contentHash_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
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
}

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
export declare const circuitSignatures: __compactRuntime.CircuitSignatures;
export declare const declaredInterfaces: __compactRuntime.DeclaredInterfaces;
