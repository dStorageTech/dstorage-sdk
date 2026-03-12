import {
  DStorage,
  MockStorageAdapter,
  ArweaveStorageAdapter,
  ArweaveLocalStorageAdapter,
  AutonomiStorageAdapter,
  MockMidnightChainAdapter,
  MidnightChainAdapter,
} from "@dstorage/core";
import { PROOF_SERVER_ENDPOINT } from "./adapterConfigs";
import type { StorageAdapterKey, ChainAdapterKey, PaymentAdapterKey } from "./types";

export async function buildSDK(
  storageKey: StorageAdapterKey,
  chainKey: ChainAdapterKey,
  paymentKey: PaymentAdapterKey,
  options: {
    managedUserId: string;
    managedServiceUrl: string;
    selectedContractAddress: string;
  },
): Promise<DStorage> {
  const { managedUserId, managedServiceUrl, selectedContractAddress } = options;

  const managedConfig =
    paymentKey === "managed"
      ? {
          signingServerUrl: managedServiceUrl,
          userId: managedUserId.trim(),
          logger: console,
        }
      : { logger: console };

  if (paymentKey === "managed" && !managedUserId.trim()) {
    throw new Error("Managed payments require a userId.");
  }

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
        : storageKey === "autonomi"
          ? new AutonomiStorageAdapter()
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

  return new DStorage({ storageAdapter, chainAdapter, logger: console });
}
