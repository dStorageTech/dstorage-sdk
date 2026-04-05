import { ArweaveLocalStorageAdapter } from "@dstorage/storage";

/**
 * Check whether arlocal is reachable at the given URL.
 * Returns true if the server responds, false otherwise.
 */
export async function checkArlocal(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Create an ArweaveLocalStorageAdapter backed by a fresh test wallet.
 * Mines an initial block so the wallet is funded and ready.
 */
export async function createStorageAdapter(url?: string): Promise<{
  adapter: ArweaveLocalStorageAdapter;
  address: string;
}> {
  const { adapter, address } =
    await ArweaveLocalStorageAdapter.createWithTestWallet(
      url ? { gateway: parseGateway(url) } : undefined,
    );
  // Mine a block so the mint transaction is confirmed before any test uploads.
  await adapter.testnet.mine();
  return { adapter, address };
}


// ── Internal helpers ───────────────────────────────────────────────────────────

function parseGateway(url: string): {
  host: string;
  port: number;
  protocol: string;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80")),
    protocol: parsed.protocol.replace(":", ""),
  };
}
