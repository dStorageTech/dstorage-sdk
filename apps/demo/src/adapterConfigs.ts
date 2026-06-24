import type {
  StorageAdapterKey,
  ChainAdapterKey,
  PaymentAdapterKey,
} from "./types";

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
