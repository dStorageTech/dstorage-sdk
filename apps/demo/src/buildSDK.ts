import {
  DStorage,
  MockStorageAdapter,
  ArweaveStorageAdapter,
  ArweaveLocalStorageAdapter,
  MockMidnightChainAdapter,
  MidnightChainAdapter,
} from "@dstorage-tech/dstorage";
import {
  PasswordEncryptionAdapter,
  type EncryptionAdapter,
} from "@dstorage/encryption";
import { PROOF_SERVER_ENDPOINT } from "./adapterConfigs";
import type {
  StorageAdapterKey,
  ChainAdapterKey,
  PaymentAdapterKey,
} from "./types";

export async function buildSDK(
  storageKey: StorageAdapterKey,
  chainKey: ChainAdapterKey,
  paymentKey: PaymentAdapterKey,
  options: {
    managedAuthToken: string;
    managedServiceUrl: string;
    selectedContractAddress: string;
    encryptionAdapter?: EncryptionAdapter;
  },
): Promise<DStorage> {
  const {
    managedAuthToken,
    managedServiceUrl,
    selectedContractAddress,
    encryptionAdapter,
  } = options;

  if (paymentKey === "managed" && !managedAuthToken.trim()) {
    throw new Error(
      "[dStorage] An auth token is required when using the managed payment service.",
    );
  }

  const managedConfig =
    paymentKey === "managed"
      ? {
          signingServerUrl: managedServiceUrl,
          authToken: managedAuthToken.trim(),
          logger: console,
        }
      : { logger: console };

  let storageAdapter;
  if (storageKey === "arweave-local") {
    if (paymentKey === "managed") {
      storageAdapter = new ArweaveLocalStorageAdapter(managedConfig);
    } else {
      const { adapter } =
        await ArweaveLocalStorageAdapter.createWithTestWallet();
      storageAdapter = adapter;
    }
  } else {
    storageAdapter =
      storageKey === "arweave"
        ? new ArweaveStorageAdapter(managedConfig)
        : new MockStorageAdapter();
  }

  let chainAdapter;
  if (chainKey === "midnight-connector") {
    const midnightConfig: ConstructorParameters<
      typeof MidnightChainAdapter
    >[0] = {
      walletMode: "connector",
      network: "preprod",
      proofServerEndpoint: PROOF_SERVER_ENDPOINT,
      zkConfigBaseUrl: window.location.origin,
      ...managedConfig,
    };
    if (selectedContractAddress.trim()) {
      midnightConfig.contractAddress = selectedContractAddress.trim();
    }
    chainAdapter = new MidnightChainAdapter(midnightConfig);
  } else {
    chainAdapter = new MockMidnightChainAdapter({
      logger: console,
    });
  }

  const encryptionAdapters = encryptionAdapter
    ? [encryptionAdapter]
    : [
        new PasswordEncryptionAdapter({
          password: "dstorage-demo-password-2026!",
          salt: "dstorage:demo:v1",
        }),
      ];

  return new DStorage({
    storageAdapter,
    chainAdapter,
    encryptionAdapters,
    logger: console,
  });
}
