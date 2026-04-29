/**
 * @dstorage/core — metaTx/utils.ts
 *
 * Helpers used internally by MetaTx and one exported utility.
 */

import type { MetaTxStepState } from "./types.js";
import type { TokenSymbol } from "@dstorage/payment";

// ── Token selector ────────────────────────────────────────────────────────────

/**
 * Return the default chain payment token for a given chain provider name.
 */
export function defaultChainToken(chainProvider: string): TokenSymbol {
  switch (chainProvider) {
    case "midnight":
      return "DUST";
    default:
      return "MOCK";
  }
}

// ── Step builder ──────────────────────────────────────────────────────────────

export function buildInitialSteps(): MetaTxStepState[] {
  return [
    {
      id: "estimate",
      label: "Estimate Costs",
      description: "Calculate storage fee + chain transaction fee",
      status: "pending",
    },
    {
      id: "encrypt",
      label: "Encrypt File",
      description: "Client side encryption using your wallet key",
      status: "pending",
    },
    {
      id: "payment_storage",
      label: "Storage Payment",
      description: "Pay storage network fee",
      status: "pending",
    },
    {
      id: "upload",
      label: "Upload to Storage",
      description: "Send encrypted file to decentralised network",
      status: "pending",
    },
    {
      id: "chain_reference",
      label: "Write On-Chain Reference",
      description: "Store file pointer + metadata on blockchain",
      status: "pending",
    },
    {
      id: "complete",
      label: "Complete",
      description: "Meta-transaction finalised",
      status: "pending",
    },
  ];
}

// ── Internal utilities ────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncateId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

export async function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsArrayBuffer(file);
  });
}
