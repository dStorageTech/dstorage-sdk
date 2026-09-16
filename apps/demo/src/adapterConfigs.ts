import type {
  StorageAdapterKey,
  ChainAdapterKey,
  PaymentAdapterKey,
} from "./types";
import type { StorageProviderName } from "@dstorage-tech/dstorage-sdk";

export const PROOF_SERVER_ENDPOINT = "http://127.0.0.1:6300";

export const ADAPTER_CONFIGS: Record<
  StorageAdapterKey,
  {
    label: string;
    description: string;
    note?: string;
    cmd?: string;
  }
> = {
  mock: {
    label: "Mock Storage",
    description:
      "In-memory store, no network. Instant — ideal for development.",
  },
  "arweave-local": {
    label: "Arweave Local",
    description: "Local arlocal node — real Arweave flow, no AR tokens needed.",
    note: "Requires a local arlocal server running at http://localhost:1984",
    cmd: "docker run -d --rm -p 1984:1984 textury/arlocal",
  },
  arweave: {
    label: "Arweave",
    description: "Pay-once permanent storage on the permaweb.",
    note: "Requires the ArConnect browser extension",
  },
  "arweave-bundler": {
    label: "Arweave (Bundler)",
    description:
      "ANS-104 bundled uploads with server-side signing — near-instant finality, no AR tokens needed.",
    note: "Managed payment only — requires a running dStorage payment service",
  },
};

/**
 * Maps a demo-app storage-adapter selection to the on-chain `storageProvider`
 * name(s) that adapter actually writes references under. Most keys map 1:1;
 * "arweave-local" writes under the shared "arweave" provider name (same
 * network, just pointed at a local arlocal node), and "arweave-bundler" maps
 * to the adapter's own underscored provider name ("arweave_bundler").
 */
export const STORAGE_PROVIDER_NAMES: Record<
  StorageAdapterKey,
  StorageProviderName
> = {
  mock: "mock",
  "arweave-local": "arweave",
  arweave: "arweave",
  "arweave-bundler": "arweave_bundler",
};

export const CHAIN_ADAPTER_CONFIGS: Record<
  ChainAdapterKey,
  {
    label: string;
    description: string;
    note?: string;
  }
> = {
  mock: {
    label: "Midnight Simulator",
    description:
      "Simulated Midnight chain. Instant transactions — ideal for development.",
  },
  "midnight-connector": {
    label: "Midnight Network",
    description: "Real Midnight network via browser wallet extension.",
    note: "Requires Lace wallet extension",
  },
};

export const PAYMENT_ADAPTER_CONFIGS: Record<
  PaymentAdapterKey,
  {
    label: string;
    description: string;
    status: "live" | "preview" | "stub";
    note?: string;
  }
> = {
  local: {
    label: "Local Payment",
    description:
      "Pay directly from your browser wallet extension (ArConnect for Arweave, Lace for Midnight).",
    status: "live",
  },
  managed: {
    label: "Managed Payment",
    description: "dStorage API service handles payments on behalf of the user.",
    status: "live",
    note: "Requires a running dStorage payment service",
  },
};
