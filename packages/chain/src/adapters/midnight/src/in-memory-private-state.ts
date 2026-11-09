/**
 * In-memory private state provider for browser environments.
 *
 * State is NOT persisted across page reloads — suitable for demos and
 * browser dApps where per-session state is sufficient.
 *
 * In the future, dStorage could provide alternative private state providers
 * that persist state on decentralised networks, enabling cross-device access
 * and resilience without relying on any centralised storage backend.
 */

/** Zero any byte arrays a replaced or removed private state held. */
const wipe = (state: unknown): void => {
  if (state != null && typeof state === "object") {
    for (const v of Object.values(state as object)) {
      if (v instanceof Uint8Array) v.fill(0);
    }
  }
};

const unsupported = (method: string) => (): Promise<never> =>
  Promise.reject(
    new Error(
      `[dStorage/midnight] ${method} is not supported by the in-memory private state provider.`,
    ),
  );

export const createInMemoryPrivateStateProvider = <
  PSI extends string = string,
  PS = unknown,
>() => {
  // Private states per contract. Addresses are compared in lower case, as
  // Midnight.js providers do.
  const contracts = new Map<string, Map<PSI, PS>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signingKeys: Record<string, any> = {};

  const statesOf = (contractAddress: string): Map<PSI, PS> => {
    const key = contractAddress.toLowerCase();
    let states = contracts.get(key);
    if (!states) {
      states = new Map<PSI, PS>();
      contracts.set(key, states);
    }
    return states;
  };

  return {
    forContract(contractAddress: string) {
      const record = statesOf(contractAddress);
      return {
        contractAddress,
        set(key: PSI, state: PS): Promise<void> {
          wipe(record.get(key));
          record.set(key, state);
          return Promise.resolve();
        },
        get(key: PSI): Promise<PS | null> {
          return Promise.resolve(record.get(key) ?? null);
        },
        remove(key: PSI): Promise<void> {
          wipe(record.get(key));
          record.delete(key);
          return Promise.resolve();
        },
        clear(): Promise<void> {
          record.forEach(wipe);
          record.clear();
          return Promise.resolve();
        },
        exportPrivateStates: unsupported("exportPrivateStates"),
        importPrivateStates: unsupported("importPrivateStates"),
      };
    },
    clearAll(): Promise<void> {
      contracts.forEach((record) => record.forEach(wipe));
      contracts.clear();
      return Promise.resolve();
    },
    setSigningKey(contractAddress: string, signingKey: unknown): Promise<void> {
      signingKeys[contractAddress.toLowerCase()] = signingKey;
      return Promise.resolve();
    },
    getSigningKey(contractAddress: string): Promise<unknown> {
      return Promise.resolve(
        signingKeys[contractAddress.toLowerCase()] ?? null,
      );
    },
    removeSigningKey(contractAddress: string): Promise<void> {
      delete signingKeys[contractAddress.toLowerCase()];
      return Promise.resolve();
    },
    clearSigningKeys(): Promise<void> {
      Object.keys(signingKeys).forEach((k) => delete signingKeys[k]);
      return Promise.resolve();
    },
    exportSigningKeys: unsupported("exportSigningKeys"),
    importSigningKeys: unsupported("importSigningKeys"),
  };
};
