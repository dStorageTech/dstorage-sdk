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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const createInMemoryPrivateStateProvider = <
  PSI extends string = string,
  PS = unknown,
>() => {
  const record = new Map<PSI, PS>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signingKeys: Record<string, any> = {};

  return {
    set(key: PSI, state: PS): Promise<void> {
      record.set(key, state);
      return Promise.resolve();
    },
    get(key: PSI): Promise<PS | null> {
      return Promise.resolve(record.get(key) ?? null);
    },
    remove(key: PSI): Promise<void> {
      record.delete(key);
      return Promise.resolve();
    },
    clear(): Promise<void> {
      record.clear();
      return Promise.resolve();
    },
    setSigningKey(contractAddress: string, signingKey: unknown): Promise<void> {
      signingKeys[contractAddress] = signingKey;
      return Promise.resolve();
    },
    getSigningKey(contractAddress: string): Promise<unknown> {
      return Promise.resolve(signingKeys[contractAddress] ?? null);
    },
    removeSigningKey(contractAddress: string): Promise<void> {
      delete signingKeys[contractAddress];
      return Promise.resolve();
    },
    clearSigningKeys(): Promise<void> {
      Object.keys(signingKeys).forEach((k) => delete signingKeys[k]);
      return Promise.resolve();
    },
  };
};
