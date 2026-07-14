import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Rx from "rxjs";
import { MidnightChainAdapter } from "@dstorage/chain";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import type { IntegrationEnv } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the compiled DataRegistry ZK artifacts (keys/ and zkir/).
const ZK_ARTIFACTS_PATH = path.resolve(
  __dirname,
  "../../../packages/chain/src/adapters/midnight/contracts/dataregistry/managed",
);

/**
 * Check whether the proof server is reachable.
 */
export async function checkProofServer(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    // The proof server returns 200/404/405 — any response means it's up.
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Build a MidnightChainAdapter in provider (facade) mode from the integration
 * env config. Wallet initialization follows the same sequence as the demo
 * console's initWallet: build → start → syncWallet → waitForUnshieldedFunds.
 */
export async function createChainAdapter(
  env: IntegrationEnv,
): Promise<MidnightChainAdapter> {
  const { midnight } = env;

  const walletNetworkId =
    midnight.network === "undeployed" ? "undeployed" : "preprod";

  const { setNetworkId } =
    await import("@midnight-ntwrk/midnight-js-network-id");
  setNetworkId(walletNetworkId);

  // Resolve seed to hex (mnemonic → 128-char hex via HD derivation).
  let seedHex: string | undefined;
  if (midnight.seed) {
    if (midnight.seed.includes(" ")) {
      const { KeyDeriver } = await import("@dstorage/crypto");
      const seed = await new KeyDeriver({ mnemonic: midnight.seed }).getSeed();
      seedHex = Array.from(seed)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } else {
      seedHex = midnight.seed;
    }
  }

  const envConfig = {
    walletNetworkId,
    networkId: walletNetworkId,
    indexer: midnight.indexerEndpoint,
    indexerWS: midnight.indexerWsEndpoint,
    node: midnight.nodeEndpoint,
    nodeWS: midnight.nodeWsEndpoint,
    proofServer: env.proofServer,
  };

  // Build and start the wallet — exact same sequence as demo console initWallet.
  const { MidnightWalletProvider } = await import("./wallet-provider.js");
  const walletProvider = await MidnightWalletProvider.build(envConfig, seedHex);
  await walletProvider.start();

  // Wait for full wallet sync — same logic as demo console syncWallet.
  console.log("Syncing wallet...");
  await Rx.firstValueFrom(
    walletProvider.wallet.state().pipe(
      Rx.throttleTime(2_000),
      Rx.filter((state: any) => state.isSynced),
      Rx.tap(() => console.log("Wallet sync complete")),
      Rx.timeout({
        each: 360_000,
        with: () =>
          Rx.throwError(() => new Error("Wallet sync timeout after 360s")),
      }),
    ),
  );

  // Wait for NIGHT funds — same logic as demo console waitForUnshieldedFunds.
  const { unshieldedToken } =
    await import("@midnight-ntwrk/midnight-js-protocol/ledger");
  const token = unshieldedToken();
  const initialState = await Rx.firstValueFrom(
    walletProvider.wallet.unshielded.state,
  );
  if (!initialState.balances[token.raw]) {
    console.log("Waiting for NIGHT funds...");
    await Rx.firstValueFrom(
      walletProvider.wallet.state().pipe(
        Rx.throttleTime(2_000),
        Rx.filter((state: any) => !!state.unshielded?.balances?.[token.raw]),
        Rx.timeout({
          each: 360_000,
          with: () =>
            Rx.throwError(() => new Error("Timeout waiting for NIGHT funds")),
        }),
      ),
    );
  }

  const adapter = new MidnightChainAdapter({
    walletMode: "provider",
    network: midnight.network,
    walletProvider,
    privateStatePassword: "Aa1!" + seedHex,
    zkArtifactsPath: ZK_ARTIFACTS_PATH,
    nodeEndpoint: midnight.nodeEndpoint,
    nodeWsEndpoint: midnight.nodeWsEndpoint,
    indexerEndpoint: midnight.indexerEndpoint,
    indexerWsEndpoint: midnight.indexerWsEndpoint,
    proofServerEndpoint: env.proofServer,
    ...(midnight.contractAddress
      ? { contractAddress: midnight.contractAddress }
      : {}),
  });

  return adapter;
}

/**
 * Returns true if all prerequisites for the full-stack Midnight suite are met:
 * a seed is configured and the proof server is reachable.
 */
export async function isMidnightAvailable(
  env: IntegrationEnv,
): Promise<boolean> {
  if (!env.midnight.seed) {
    console.warn(
      "[integration] INTEGRATION_SEED not set — will skip Midnight suite.",
    );
    return false;
  }
  const ok = await checkProofServer(env.proofServer);
  if (!ok) {
    console.warn(
      `[integration] proof server not reachable at ${env.proofServer} — will skip Midnight suite.`,
    );
  }
  return ok;
}
