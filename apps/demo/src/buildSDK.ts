import {
  DStorage,
  MockStorageAdapter,
  ArweaveStorageAdapter,
  ArweaveLocalStorageAdapter,
  MockMidnightChainAdapter,
  MidnightChainAdapter,
} from "@dstorage/core";
import { DemoSeedProvider } from "@dstorage/seed-providers";
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
  },
): Promise<DStorage> {
  const { managedAuthToken, managedServiceUrl, selectedContractAddress } =
    options;

  const managedConfig =
    paymentKey === "managed"
      ? {
          signingServerUrl: managedServiceUrl,
          ...(managedAuthToken.trim()
            ? { authToken: managedAuthToken.trim() }
            : {}),
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
      nodeEndpoint: "",
      nodeWsEndpoint: "",
      indexerEndpoint: "",
      indexerWsEndpoint: "",
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

  const encryptionSeedProvider = new DemoSeedProvider();

  return new DStorage({
    storageAdapter,
    chainAdapter,
    encryptionSeedProvider,
    logger: console,
  });
}
