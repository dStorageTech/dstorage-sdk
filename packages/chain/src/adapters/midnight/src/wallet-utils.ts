import { UnshieldedTokenType } from "@midnight-ntwrk/ledger-v7";
import { type WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  type UnshieldedWallet,
  UnshieldedWalletState,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import * as Rx from "rxjs";

import { type EnvironmentConfiguration } from "@midnight-ntwrk/testkit-js";
import type { Logger } from "../../../types.js";
import { UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

export const getInitialState = async (
  wallet: ShieldedWallet | UnshieldedWallet,
): Promise<unknown> => {
  if (wallet instanceof ShieldedWallet) {
    return Rx.firstValueFrom((wallet as ShieldedWallet).state);
  } else {
    return Rx.firstValueFrom((wallet as UnshieldedWallet).state);
  }
};

export const getInitialShieldedState = async (
  wallet: ShieldedWallet,
  logger?: Logger,
): Promise<unknown> => {
  logger?.log("dStorage/midnight", "Getting initial state of wallet...");
  return Rx.firstValueFrom(wallet.state);
};

export const getInitialUnshieldedState = async (
  wallet: UnshieldedWallet,
  logger?: Logger,
) => {
  logger?.log("dStorage/midnight", "Getting initial state of wallet...");
  return Rx.firstValueFrom(wallet.state);
};

export const syncWallet = (
  wallet: WalletFacade,
  throttleTime = 2_000,
  timeout = 360_000,
  logger?: Logger,
) => {
  logger?.log("dStorage/midnight", "Syncing wallet...");

  return Rx.firstValueFrom(
    wallet.state().pipe(
      /*Rx.tap((state) => {
        logger?.log(
          `Wallet synced state emission: { shielded=${state.shielded.state.progress.isStrictlyComplete()}, unshielded=${state.unshielded.progress.isStrictlyComplete()}, dust=${state.dust.state.progress.isStrictlyComplete()} }`,
        );
      }),*/
      Rx.throttleTime(throttleTime),
      Rx.tap((state) => {
        const isSynced =
          state.shielded.state.progress.isStrictlyComplete() &&
          state.dust.state.progress.isStrictlyComplete() &&
          state.unshielded.progress?.isStrictlyComplete() === true;

        /*logger?.log(
          `Wallet synced state emission (synced=${isSynced}): { shielded=${state.shielded.state.progress.isStrictlyComplete()}, unshielded=${state.unshielded.progress.isStrictlyComplete()}, dust=${state.dust.state.progress.isStrictlyComplete()} }`,
        );*/
      }),
      Rx.filter(
        (state) =>
          state.shielded.state.progress.isStrictlyComplete() &&
          state.dust.state.progress.isStrictlyComplete() &&
          state.unshielded.progress.isStrictlyComplete() === true,
      ),
      Rx.tap(() => logger?.log("dStorage/midnight", "Sync complete")),
      Rx.tap((state) => {
        const shieldedBalances = state.shielded.balances || {};
        const unshieldedBalances = state.unshielded.balances || {};
        const dustBalances =
          state.dust.walletBalance(new Date(Date.now())) || 0n;

        logger?.log(
          "dStorage/midnight",
          `Wallet balances after sync - Shielded: ${JSON.stringify(shieldedBalances)}, Unshielded: ${JSON.stringify(unshieldedBalances)}, Dust: ${dustBalances}`,
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
  fundFromFaucet = false,
  logger?: Logger,
): Promise<UnshieldedWalletState> => {
  const initialState = await getInitialUnshieldedState(
    wallet.unshielded,
    logger,
  );
  const unshieldedAddress = UnshieldedAddress.codec.encode(
    getNetworkId(),
    initialState.address,
  );
  logger?.log(
    "dStorage/midnight",
    `Using unshielded address: ${unshieldedAddress.toString()} waiting for funds...`,
  );
  /*if (fundFromFaucet && env.faucet) {
    logger?.log('Requesting tokens from faucet...');
    await new FaucetClient(env.faucet, logger).requestTokens(unshieldedAddress.toString());
  }*/
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
