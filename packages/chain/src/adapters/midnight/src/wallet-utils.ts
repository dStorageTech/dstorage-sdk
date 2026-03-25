import { type UnshieldedTokenType } from "@midnight-ntwrk/ledger-v8";
import { type WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { type UnshieldedWalletState } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import * as Rx from "rxjs";

import type { Logger } from "../../../types.js";
import { UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { EnvironmentConfiguration } from "./wallet-provider.js";

export const syncWallet = (
  wallet: WalletFacade,
  throttleTime = 2_000,
  timeout = 360_000,
  logger?: Logger,
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

export const waitForUnshieldedFunds = async (
  wallet: WalletFacade,
  env: EnvironmentConfiguration,
  tokenType: UnshieldedTokenType,
  logger?: Logger,
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
