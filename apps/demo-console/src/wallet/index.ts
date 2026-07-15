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
import { bytesToBase64url } from "@dstorage/crypto";
import { type UnshieldedTokenType } from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { type WalletFacade } from "@midnight-ntwrk/wallet-sdk/facade";
import { type UnshieldedWalletState } from "@midnight-ntwrk/wallet-sdk/unshielded";
import * as Rx from "rxjs";
import { UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk/address-format";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

export type { MidnightWalletProvider, EnvironmentConfiguration };

// ── Password derivation ────────────────────────────────────────────────────────

/**
 * Derives a deterministic LevelDB encryption password from the wallet seed hex.
 *
 * Uses HKDF-SHA-256 to derive a 32-byte key from the seed, then encodes it as
 * base64url and prepends "Aa1!" to satisfy the wallet SDK password policy
 * (at least 3 of 4 character classes: uppercase, lowercase, digits, special).
 *
 * The HKDF step is one-way: the seed cannot be recovered from the password even
 * if the password is observed (e.g. in a memory dump or log).
 */
export async function derivePrivateStatePassword(
  seedHex: string | undefined,
): Promise<string> {
  if (!seedHex) {
    throw new Error(
      "Cannot derive private state password: no wallet seed available.",
    );
  }
  const seedBytes = Uint8Array.from(
    seedHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
  );
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    seedBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const enc = new TextEncoder();
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode("dstorage:leveldb-password:v1"),
    },
    keyMaterial,
    256,
  );
  return "Aa1!" + bytesToBase64url(new Uint8Array(bits));
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
async function buildWalletProvider(
  env: EnvironmentConfiguration,
  seedHex: string | undefined,
): Promise<MidnightWalletProvider> {
  const walletProvider = await MidnightWalletProvider.build(env, seedHex);
  await walletProvider.start();
  return walletProvider;
}

// ── Wallet initialisation ─────────────────────────────────────────────────────

export async function initWallet(
  envConfig: EnvironmentConfiguration,
  seedHex: string | undefined,
  skipFundCheck: boolean,
  ticker: <T>(statusLine: () => string, fn: () => Promise<T>) => Promise<T>,
): Promise<MidnightWalletProvider> {
  const { setNetworkId } =
    await import("@midnight-ntwrk/midnight-js-network-id");
  setNetworkId(envConfig.networkId);

  const walletProvider = await ticker(
    () => "Building wallet...",
    () => buildWalletProvider(envConfig, seedHex),
  );
  if (skipFundCheck) {
    console.log(
      "Managed payment mode — skipping wallet sync and NIGHT balance check.",
    );
  } else {
    const SAVE_INTERVAL_MS = 30_000;
    const saveInterval = setInterval(() => {
      void walletProvider.saveState();
    }, SAVE_INTERVAL_MS);
    try {
      await ticker(
        () => "Syncing wallet...",
        () => syncWallet(walletProvider.wallet, 2_000, 3_600_000),
      );
    } finally {
      clearInterval(saveInterval);
    }
    await ticker(
      () => "Caching wallet state...",
      () => walletProvider.saveState(),
    );
    const { unshieldedToken } =
      await import("@midnight-ntwrk/midnight-js-protocol/ledger");
    const unshieldedState = await ticker(
      () => "Waiting for NIGHT funds...",
      () => waitForUnshieldedFunds(walletProvider.wallet, unshieldedToken()),
    );
    const nightBalance = unshieldedState.balances[unshieldedToken().raw];
    if (nightBalance === undefined) {
      console.log("No funds received, exiting...");
      throw new Error("No NIGHT funds received/detected.");
    }
    console.log(`Your NIGHT wallet balance is: ${nightBalance}`);
  }
  return walletProvider;
}

// ── Wallet sync ────────────────────────────────────────────────────────────────

export const syncWallet = (
  wallet: WalletFacade,
  throttleTime = 2_000,
  timeout = 360_000,
) => {
  console.log("Syncing wallet...");

  return Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(throttleTime),
      Rx.filter((state) => state.isSynced),
      Rx.tap(() => console.log("Sync complete")),
      Rx.tap((state) => {
        const shieldedBalances = state.shielded.balances || {};
        const unshieldedBalances = state.unshielded.balances || {};
        const dustBalances = state.dust.balance(new Date(Date.now())) || 0n;

        console.debug(
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
  tokenType: UnshieldedTokenType,
): Promise<UnshieldedWalletState> => {
  const initialState = await Rx.firstValueFrom(wallet.unshielded.state);
  const unshieldedAddress = UnshieldedAddress.codec.encode(
    getNetworkId(),
    initialState.address,
  );
  console.log(
    `Using unshielded address: ${unshieldedAddress.toString()} waiting for funds...`,
  );
  const initialBalance = initialState.balances[tokenType.raw];
  if (initialBalance === undefined || initialBalance === 0n) {
    console.log("Your wallet initial balance is: 0 (not yet initialized)");
    console.log("Waiting to receive tokens...");
    const facadeState = await syncWallet(wallet, 2_000, 360_000);
    return facadeState.unshielded;
  }
  return initialState;
};
