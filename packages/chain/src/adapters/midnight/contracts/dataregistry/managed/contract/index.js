import * as __compactRuntime from "@midnight-ntwrk/compact-runtime";
__compactRuntime.checkRuntimeVersion("0.14.0");

const _descriptor_0 = new __compactRuntime.CompactTypeBytes(32);

const _descriptor_1 = __compactRuntime.CompactTypeOpaqueString;

class _ReferenceEntry_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_1.alignment());
  }
  fromValue(value_0) {
    return {
      storageId: _descriptor_0.fromValue(value_0),
      storageProvider: _descriptor_1.fromValue(value_0),
    };
  }
  toValue(value_0) {
    return _descriptor_0
      .toValue(value_0.storageId)
      .concat(_descriptor_1.toValue(value_0.storageProvider));
  }
}

const _descriptor_2 = new _ReferenceEntry_0();

const _descriptor_3 = __compactRuntime.CompactTypeBoolean;

const _descriptor_4 = new __compactRuntime.CompactTypeUnsignedInteger(
  65535n,
  2,
);

const _descriptor_5 = new __compactRuntime.CompactTypeUnsignedInteger(
  18446744073709551615n,
  8,
);

const _descriptor_6 = new __compactRuntime.CompactTypeVector(3, _descriptor_0);

class _Either_0 {
  alignment() {
    return _descriptor_3
      .alignment()
      .concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_3.fromValue(value_0),
      left: _descriptor_0.fromValue(value_0),
      right: _descriptor_0.fromValue(value_0),
    };
  }
  toValue(value_0) {
    return _descriptor_3
      .toValue(value_0.is_left)
      .concat(
        _descriptor_0
          .toValue(value_0.left)
          .concat(_descriptor_0.toValue(value_0.right)),
      );
  }
}

const _descriptor_7 = new _Either_0();

const _descriptor_8 = new __compactRuntime.CompactTypeUnsignedInteger(
  340282366920938463463374607431768211455n,
  16,
);

class _ContractAddress_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0),
    };
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_9 = new _ContractAddress_0();

const _descriptor_10 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);

export class Contract {
  witnesses;
  constructor(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(
        `Contract constructor: expected 1 argument, received ${args_0.length}`,
      );
    }
    const witnesses_0 = args_0[0];
    if (typeof witnesses_0 !== "object") {
      throw new __compactRuntime.CompactError(
        "first (witnesses) argument to Contract constructor is not an object",
      );
    }
    this.witnesses = witnesses_0;
    this.circuits = {
      deriveRefId(context, ...args_1) {
        return { result: pureCircuits.deriveRefId(...args_1), context };
      },
      storeReference: (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(
            `storeReference: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`,
          );
        }
        const contextOrig_0 = args_1[0];
        const storageId_0 = args_1[1];
        const storageProvider_0 = args_1[2];
        if (
          !(
            typeof contextOrig_0 === "object" &&
            contextOrig_0.currentQueryContext != undefined
          )
        ) {
          __compactRuntime.typeError(
            "storeReference",
            "argument 1 (as invoked from Typescript)",
            "DataRegistry.compact line 57 char 1",
            "CircuitContext",
            contextOrig_0,
          );
        }
        if (
          !(
            storageId_0.buffer instanceof ArrayBuffer &&
            storageId_0.BYTES_PER_ELEMENT === 1 &&
            storageId_0.length === 32
          )
        ) {
          __compactRuntime.typeError(
            "storeReference",
            "argument 1 (argument 2 as invoked from Typescript)",
            "DataRegistry.compact line 57 char 1",
            "Bytes<32>",
            storageId_0,
          );
        }
        const context = {
          ...contextOrig_0,
          gasCost: __compactRuntime.emptyRunningCost(),
        };
        const partialProofData = {
          input: {
            value: _descriptor_0
              .toValue(storageId_0)
              .concat(_descriptor_1.toValue(storageProvider_0)),
            alignment: _descriptor_0
              .alignment()
              .concat(_descriptor_1.alignment()),
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: [],
        };
        const result_0 = this._storeReference_0(
          context,
          partialProofData,
          storageId_0,
          storageProvider_0,
        );
        partialProofData.output = {
          value: _descriptor_0.toValue(result_0),
          alignment: _descriptor_0.alignment(),
        };
        return {
          result: result_0,
          context: context,
          proofData: partialProofData,
          gasCost: context.gasCost,
        };
      },
    };
    this.impureCircuits = { storeReference: this.circuits.storeReference };
  }
  initialState(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(
        `Contract state constructor: expected 1 argument (as invoked from Typescript), received ${args_0.length}`,
      );
    }
    const constructorContext_0 = args_0[0];
    if (typeof constructorContext_0 !== "object") {
      throw new __compactRuntime.CompactError(
        `Contract state constructor: expected 'constructorContext' in argument 1 (as invoked from Typescript) to be an object`,
      );
    }
    if (!("initialZswapLocalState" in constructorContext_0)) {
      throw new __compactRuntime.CompactError(
        `Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript)`,
      );
    }
    if (typeof constructorContext_0.initialZswapLocalState !== "object") {
      throw new __compactRuntime.CompactError(
        `Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript) to be an object`,
      );
    }
    const state_0 = new __compactRuntime.ContractState();
    let stateValue_0 = __compactRuntime.StateValue.newArray();
    stateValue_0 = stateValue_0.arrayPush(
      __compactRuntime.StateValue.newNull(),
    );
    stateValue_0 = stateValue_0.arrayPush(
      __compactRuntime.StateValue.newNull(),
    );
    stateValue_0 = stateValue_0.arrayPush(
      __compactRuntime.StateValue.newNull(),
    );
    state_0.data = new __compactRuntime.ChargedState(stateValue_0);
    state_0.setOperation(
      "storeReference",
      new __compactRuntime.ContractOperation(),
    );
    const context = __compactRuntime.createCircuitContext(
      __compactRuntime.dummyContractAddress(),
      constructorContext_0.initialZswapLocalState.coinPublicKey,
      state_0.data,
      constructorContext_0.initialPrivateState,
    );
    const partialProofData = {
      input: { value: [], alignment: [] },
      output: undefined,
      publicTranscript: [],
      privateTranscriptOutputs: [],
    };
    __compactRuntime.queryLedgerState(context, partialProofData, [
      {
        push: {
          storage: false,
          value: __compactRuntime.StateValue.newCell({
            value: _descriptor_10.toValue(0n),
            alignment: _descriptor_10.alignment(),
          }).encode(),
        },
      },
      {
        push: {
          storage: true,
          value: __compactRuntime.StateValue.newMap(
            new __compactRuntime.StateMap(),
          ).encode(),
        },
      },
      { ins: { cached: false, n: 1 } },
    ]);
    __compactRuntime.queryLedgerState(context, partialProofData, [
      {
        push: {
          storage: false,
          value: __compactRuntime.StateValue.newCell({
            value: _descriptor_10.toValue(1n),
            alignment: _descriptor_10.alignment(),
          }).encode(),
        },
      },
      {
        push: {
          storage: true,
          value: __compactRuntime.StateValue.newCell({
            value: _descriptor_5.toValue(0n),
            alignment: _descriptor_5.alignment(),
          }).encode(),
        },
      },
      { ins: { cached: false, n: 1 } },
    ]);
    __compactRuntime.queryLedgerState(context, partialProofData, [
      {
        push: {
          storage: false,
          value: __compactRuntime.StateValue.newCell({
            value: _descriptor_10.toValue(2n),
            alignment: _descriptor_10.alignment(),
          }).encode(),
        },
      },
      {
        push: {
          storage: true,
          value: __compactRuntime.StateValue.newCell({
            value: _descriptor_0.toValue(new Uint8Array(32)),
            alignment: _descriptor_0.alignment(),
          }).encode(),
        },
      },
      { ins: { cached: false, n: 1 } },
    ]);
    const tmp_0 = 1n;
    __compactRuntime.queryLedgerState(context, partialProofData, [
      {
        idx: {
          cached: false,
          pushPath: true,
          path: [
            {
              tag: "value",
              value: {
                value: _descriptor_10.toValue(1n),
                alignment: _descriptor_10.alignment(),
              },
            },
          ],
        },
      },
      {
        addi: {
          immediate: parseInt(
            __compactRuntime.valueToBigInt(
              {
                value: _descriptor_4.toValue(tmp_0),
                alignment: _descriptor_4.alignment(),
              }.value,
            ),
          ),
        },
      },
      { ins: { cached: true, n: 1 } },
    ]);
    state_0.data = new __compactRuntime.ChargedState(
      context.currentQueryContext.state.state,
    );
    return {
      currentContractState: state_0,
      currentPrivateState: context.currentPrivateState,
      currentZswapLocalState: context.currentZswapLocalState,
    };
  }
  _persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_6, value_0);
    return result_0;
  }
  _deriveRefId_0(storageId_0, refCounter_0) {
    return this._persistentHash_0([
      new Uint8Array([
        100, 115, 116, 111, 114, 97, 103, 101, 58, 114, 101, 102, 58, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]),
      storageId_0,
      refCounter_0,
    ]);
  }
  _storeReference_0(context, partialProofData, storageId_0, storageProvider_0) {
    const refId_0 = this._deriveRefId_0(
      storageId_0,
      __compactRuntime.convertFieldToBytes(
        32,
        _descriptor_5.fromValue(
          __compactRuntime.queryLedgerState(context, partialProofData, [
            { dup: { n: 0 } },
            {
              idx: {
                cached: false,
                pushPath: false,
                path: [
                  {
                    tag: "value",
                    value: {
                      value: _descriptor_10.toValue(1n),
                      alignment: _descriptor_10.alignment(),
                    },
                  },
                ],
              },
            },
            { popeq: { cached: true, result: undefined } },
          ]).value,
        ),
        "DataRegistry.compact line 58 char 40",
      ),
    );
    __compactRuntime.assert(
      !_descriptor_3.fromValue(
        __compactRuntime.queryLedgerState(context, partialProofData, [
          { dup: { n: 0 } },
          {
            idx: {
              cached: false,
              pushPath: false,
              path: [
                {
                  tag: "value",
                  value: {
                    value: _descriptor_10.toValue(0n),
                    alignment: _descriptor_10.alignment(),
                  },
                },
              ],
            },
          },
          {
            push: {
              storage: false,
              value: __compactRuntime.StateValue.newCell({
                value: _descriptor_0.toValue(refId_0),
                alignment: _descriptor_0.alignment(),
              }).encode(),
            },
          },
          "member",
          { popeq: { cached: true, result: undefined } },
        ]).value,
      ),
      "Reference already stored",
    );
    const entry_0 = {
      storageId: storageId_0,
      storageProvider: storageProvider_0,
    };
    __compactRuntime.queryLedgerState(context, partialProofData, [
      {
        idx: {
          cached: false,
          pushPath: true,
          path: [
            {
              tag: "value",
              value: {
                value: _descriptor_10.toValue(0n),
                alignment: _descriptor_10.alignment(),
              },
            },
          ],
        },
      },
      {
        push: {
          storage: false,
          value: __compactRuntime.StateValue.newCell({
            value: _descriptor_0.toValue(refId_0),
            alignment: _descriptor_0.alignment(),
          }).encode(),
        },
      },
      {
        push: {
          storage: true,
          value: __compactRuntime.StateValue.newCell({
            value: _descriptor_2.toValue(entry_0),
            alignment: _descriptor_2.alignment(),
          }).encode(),
        },
      },
      { ins: { cached: false, n: 1 } },
      { ins: { cached: true, n: 1 } },
    ]);
    const tmp_0 = 1n;
    __compactRuntime.queryLedgerState(context, partialProofData, [
      {
        idx: {
          cached: false,
          pushPath: true,
          path: [
            {
              tag: "value",
              value: {
                value: _descriptor_10.toValue(1n),
                alignment: _descriptor_10.alignment(),
              },
            },
          ],
        },
      },
      {
        addi: {
          immediate: parseInt(
            __compactRuntime.valueToBigInt(
              {
                value: _descriptor_4.toValue(tmp_0),
                alignment: _descriptor_4.alignment(),
              }.value,
            ),
          ),
        },
      },
      { ins: { cached: true, n: 1 } },
    ]);
    return refId_0;
  }
}
export function ledger(stateOrChargedState) {
  const state =
    stateOrChargedState instanceof __compactRuntime.StateValue
      ? stateOrChargedState
      : stateOrChargedState.state;
  const chargedState =
    stateOrChargedState instanceof __compactRuntime.StateValue
      ? new __compactRuntime.ChargedState(stateOrChargedState)
      : stateOrChargedState;
  const context = {
    currentQueryContext: new __compactRuntime.QueryContext(
      chargedState,
      __compactRuntime.dummyContractAddress(),
    ),
    costModel: __compactRuntime.CostModel.initialCostModel(),
  };
  const partialProofData = {
    input: { value: [], alignment: [] },
    output: undefined,
    publicTranscript: [],
    privateTranscriptOutputs: [],
  };
  return {
    references: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(
            `isEmpty: expected 0 arguments, received ${args_0.length}`,
          );
        }
        return _descriptor_3.fromValue(
          __compactRuntime.queryLedgerState(context, partialProofData, [
            { dup: { n: 0 } },
            {
              idx: {
                cached: false,
                pushPath: false,
                path: [
                  {
                    tag: "value",
                    value: {
                      value: _descriptor_10.toValue(0n),
                      alignment: _descriptor_10.alignment(),
                    },
                  },
                ],
              },
            },
            "size",
            {
              push: {
                storage: false,
                value: __compactRuntime.StateValue.newCell({
                  value: _descriptor_5.toValue(0n),
                  alignment: _descriptor_5.alignment(),
                }).encode(),
              },
            },
            "eq",
            { popeq: { cached: true, result: undefined } },
          ]).value,
        );
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(
            `size: expected 0 arguments, received ${args_0.length}`,
          );
        }
        return _descriptor_5.fromValue(
          __compactRuntime.queryLedgerState(context, partialProofData, [
            { dup: { n: 0 } },
            {
              idx: {
                cached: false,
                pushPath: false,
                path: [
                  {
                    tag: "value",
                    value: {
                      value: _descriptor_10.toValue(0n),
                      alignment: _descriptor_10.alignment(),
                    },
                  },
                ],
              },
            },
            "size",
            { popeq: { cached: true, result: undefined } },
          ]).value,
        );
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(
            `member: expected 1 argument, received ${args_0.length}`,
          );
        }
        const key_0 = args_0[0];
        if (
          !(
            key_0.buffer instanceof ArrayBuffer &&
            key_0.BYTES_PER_ELEMENT === 1 &&
            key_0.length === 32
          )
        ) {
          __compactRuntime.typeError(
            "member",
            "argument 1",
            "DataRegistry.compact line 25 char 1",
            "Bytes<32>",
            key_0,
          );
        }
        return _descriptor_3.fromValue(
          __compactRuntime.queryLedgerState(context, partialProofData, [
            { dup: { n: 0 } },
            {
              idx: {
                cached: false,
                pushPath: false,
                path: [
                  {
                    tag: "value",
                    value: {
                      value: _descriptor_10.toValue(0n),
                      alignment: _descriptor_10.alignment(),
                    },
                  },
                ],
              },
            },
            {
              push: {
                storage: false,
                value: __compactRuntime.StateValue.newCell({
                  value: _descriptor_0.toValue(key_0),
                  alignment: _descriptor_0.alignment(),
                }).encode(),
              },
            },
            "member",
            { popeq: { cached: true, result: undefined } },
          ]).value,
        );
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(
            `lookup: expected 1 argument, received ${args_0.length}`,
          );
        }
        const key_0 = args_0[0];
        if (
          !(
            key_0.buffer instanceof ArrayBuffer &&
            key_0.BYTES_PER_ELEMENT === 1 &&
            key_0.length === 32
          )
        ) {
          __compactRuntime.typeError(
            "lookup",
            "argument 1",
            "DataRegistry.compact line 25 char 1",
            "Bytes<32>",
            key_0,
          );
        }
        return _descriptor_2.fromValue(
          __compactRuntime.queryLedgerState(context, partialProofData, [
            { dup: { n: 0 } },
            {
              idx: {
                cached: false,
                pushPath: false,
                path: [
                  {
                    tag: "value",
                    value: {
                      value: _descriptor_10.toValue(0n),
                      alignment: _descriptor_10.alignment(),
                    },
                  },
                ],
              },
            },
            {
              idx: {
                cached: false,
                pushPath: false,
                path: [
                  {
                    tag: "value",
                    value: {
                      value: _descriptor_0.toValue(key_0),
                      alignment: _descriptor_0.alignment(),
                    },
                  },
                ],
              },
            },
            { popeq: { cached: false, result: undefined } },
          ]).value,
        );
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(
            `iter: expected 0 arguments, received ${args_0.length}`,
          );
        }
        const self_0 = state.asArray()[0];
        return self_0
          .asMap()
          .keys()
          .map((key) => {
            const value = self_0.asMap().get(key).asCell();
            return [
              _descriptor_0.fromValue(key.value),
              _descriptor_2.fromValue(value.value),
            ];
          })
          [Symbol.iterator]();
      },
    },
    get refCounter() {
      return _descriptor_5.fromValue(
        __compactRuntime.queryLedgerState(context, partialProofData, [
          { dup: { n: 0 } },
          {
            idx: {
              cached: false,
              pushPath: false,
              path: [
                {
                  tag: "value",
                  value: {
                    value: _descriptor_10.toValue(1n),
                    alignment: _descriptor_10.alignment(),
                  },
                },
              ],
            },
          },
          { popeq: { cached: true, result: undefined } },
        ]).value,
      );
    },
    get owner() {
      return _descriptor_0.fromValue(
        __compactRuntime.queryLedgerState(context, partialProofData, [
          { dup: { n: 0 } },
          {
            idx: {
              cached: false,
              pushPath: false,
              path: [
                {
                  tag: "value",
                  value: {
                    value: _descriptor_10.toValue(2n),
                    alignment: _descriptor_10.alignment(),
                  },
                },
              ],
            },
          },
          { popeq: { cached: false, result: undefined } },
        ]).value,
      );
    },
  };
}
const _emptyContext = {
  currentQueryContext: new __compactRuntime.QueryContext(
    new __compactRuntime.ContractState().data,
    __compactRuntime.dummyContractAddress(),
  ),
};
const _dummyContract = new Contract({});
export const pureCircuits = {
  deriveRefId: (...args_0) => {
    if (args_0.length !== 2) {
      throw new __compactRuntime.CompactError(
        `deriveRefId: expected 2 arguments (as invoked from Typescript), received ${args_0.length}`,
      );
    }
    const storageId_0 = args_0[0];
    const refCounter_0 = args_0[1];
    if (
      !(
        storageId_0.buffer instanceof ArrayBuffer &&
        storageId_0.BYTES_PER_ELEMENT === 1 &&
        storageId_0.length === 32
      )
    ) {
      __compactRuntime.typeError(
        "deriveRefId",
        "argument 1",
        "DataRegistry.compact line 38 char 1",
        "Bytes<32>",
        storageId_0,
      );
    }
    if (
      !(
        refCounter_0.buffer instanceof ArrayBuffer &&
        refCounter_0.BYTES_PER_ELEMENT === 1 &&
        refCounter_0.length === 32
      )
    ) {
      __compactRuntime.typeError(
        "deriveRefId",
        "argument 2",
        "DataRegistry.compact line 38 char 1",
        "Bytes<32>",
        refCounter_0,
      );
    }
    return _dummyContract._deriveRefId_0(storageId_0, refCounter_0);
  },
};
export const contractReferenceLocations = {
  tag: "publicLedgerArray",
  indices: {},
};
//# sourceMappingURL=index.js.map
