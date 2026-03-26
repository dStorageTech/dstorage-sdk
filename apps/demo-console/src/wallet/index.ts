/**
 * Wallet lifecycle utilities for the dStorage console demo.
 *
 * Handles wallet construction, sync, and fund-waiting for the Midnight network.
 * Use buildWalletProvider() to create a ready-to-use MidnightWalletProvider,
 * then pass it directly to MidnightChainAdapter (walletMode: "provider").
 */

import {
  MidnightWalletProvider,
  type EnvironmentConfiguration,
} from "./wallet-provider.js";
import { type UnshieldedTokenType } from "@midnight-ntwrk/ledger-v8";
import { type WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { type UnshieldedWalletState } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import * as Rx from "rxjs";
import { UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

export type { MidnightWalletProvider, EnvironmentConfiguration };

// ── Password derivation ────────────────────────────────────────────────────────

/**
 * Derives a deterministic LevelDB encryption password from the wallet seed hex.
 *
 * The password policy requires at least 3 of 4 character classes (uppercase,
 * lowercase, digits, special characters). A raw hex seed only contains lowercase
 * letters + digits (2 classes), so we prefix with "Aa1!" which adds uppercase
 * and a special character, guaranteeing all 4 classes are present.
 * The prefix is fixed — the same seed always produces the same password.
 */
export function derivePrivateStatePassword(
  seedHex: string | undefined,
): string {
  if (!seedHex) {
    throw new Error(
      "[dStorage/midnight] Cannot derive private state password: no wallet seed available.",
    );
  }
  return "Aa1!" + seedHex;
}

// ── Seed resolution ────────────────────────────────────────────────────────────

/**
 * Resolves a wallet seed as a hex string.
 * If a hex seed is provided directly, returns it as-is.
 * If only a mnemonic is provided, derives the 64-byte seed via KeyDeriver
 * and returns it as a 128-char hex string so the wallet always uses the same keys.
 */
export async function resolveSeedHex(credentials: {
  mnemonic?: string;
  seedHex?: string;
}): Promise<string | undefined> {
  if (credentials.seedHex) return credentials.seedHex;
  if (credentials.mnemonic) {
    const { KeyDeriver } = await import("@dstorage/crypto");
    const deriver = new KeyDeriver({ mnemonic: credentials.mnemonic });
    const seed = await deriver.getSeed();
    return Array.from(seed)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return undefined;
}

// ── Wallet construction ────────────────────────────────────────────────────────

/**
 * Build and start a MidnightWalletProvider from a master seed hex string.
 * HD-derives per-role seeds (Zswap, NightExternal, Dust) and initialises
 * the WalletFacade. The returned provider is already started.
 */
export async function buildWalletProvider(
  env: EnvironmentConfiguration,
  seedHex: string | undefined,
  logger?: { log: (ns: string, msg: string) => void },
): Promise<MidnightWalletProvider> {
  const walletProvider = await MidnightWalletProvider.build(
    env,
    seedHex,
    logger,
  );
  await walletProvider.start();
  return walletProvider;
}

// ── Wallet sync ────────────────────────────────────────────────────────────────

export const syncWallet = (
  wallet: WalletFacade,
  throttleTime = 2_000,
  timeout = 360_000,
  logger?: { log: (ns: string, msg: string) => void },
) => {
  logger?.log("dStorage/midnight", "Syncing wallet...");

  return Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(throttleTime),
      Rx.filter((state) => state.isSynced),
      Rx.tap(() => logger?.log("dStorage/midnight", "Sync complete")),
      Rx.tap((state) => {
        const shieldedBalances = state.shielded.balances || {};
        const unshieldedBalances = state.unshielded.balances || {};
        const dustBalances = state.dust.balance(new Date(Date.now())) || 0n;

        logger?.log(
          "dStorage/midnight",
          `Wallet balances after sync - Shielded: ${JSON.stringify(shieldedBalances, (_, v) => (typeof v === "bigint" ? v.toString() : v))}, Unshielded: ${JSON.stringify(unshieldedBalances, (_, v) => (typeof v === "bigint" ? v.toString() : v))}, Dust: ${dustBalances}`,
        );
      }),
      Rx.timeout({
        each: timeout,
        with: () =>
          Rx.throwError(
            () => new Error(`Wallet sync timeout after ${timeout}ms`),
          ),
      }),
    ),
  );
};

// ── Fund waiting ───────────────────────────────────────────────────────────────

export const waitForUnshieldedFunds = async (
  wallet: WalletFacade,
  env: EnvironmentConfiguration,
  tokenType: UnshieldedTokenType,
  logger?: { log: (ns: string, msg: string) => void },
): Promise<UnshieldedWalletState> => {
  const initialState = await Rx.firstValueFrom(wallet.unshielded.state);
  const unshieldedAddress = UnshieldedAddress.codec.encode(
    getNetworkId(),
    initialState.address,
  );
  logger?.log(
    "dStorage/midnight",
    `Using unshielded address: ${unshieldedAddress.toString()} waiting for funds...`,
  );
  const initialBalance = initialState.balances[tokenType.raw];
  if (initialBalance === undefined || initialBalance === 0n) {
    logger?.log(
      "dStorage/midnight",
      "Your wallet initial balance is: 0 (not yet initialized)",
    );
    logger?.log("dStorage/midnight", "Waiting to receive tokens...");
    const facadeState = await syncWallet(wallet, 2_000, 360_000, logger);
    return facadeState.unshielded;
  }
  return initialState;
};
