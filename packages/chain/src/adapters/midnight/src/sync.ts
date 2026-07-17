/**
 * @dstorage/chain — adapters/midnight/sync.ts
 *
 * Wallet sync-waiting helper.
 */

import type {
  WalletFacade,
  FacadeState,
} from "@midnight-ntwrk/wallet-sdk/facade";

/**
 * Wait for a WalletFacade to report `isSynced`, falling back to the current
 * facade state after `timeoutMs`.
 *
 * `isSynced` (and `waitForSyncedState()`) gate on an internal `isConnected` flag
 * on the shielded/dust sub-wallets that only flips true once a non-empty batch of
 * events arrives from the indexer — on a quiet chain (idle Preprod, fresh
 * undeployed network) it can stay false forever even though the wallet has
 * genuinely caught up, so waiting on it unconditionally can hang indefinitely.
 */
export async function waitForFacadeSync(
  facade: Pick<WalletFacade, "state">,
  timeoutMs = 300_000,
): Promise<FacadeState> {
  const rx = await import("rxjs");
  try {
    return await rx.firstValueFrom(
      facade.state().pipe(
        rx.filter((state: FacadeState) => state.isSynced),
        rx.timeout(timeoutMs),
      ),
    );
  } catch {
    return await rx.firstValueFrom(facade.state());
  }
}
