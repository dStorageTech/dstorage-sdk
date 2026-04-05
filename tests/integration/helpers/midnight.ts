import path from "node:path";
import { fileURLToPath } from "node:url";
import { MidnightChainAdapter } from "@dstorage/chain";
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
 * env config. The wallet is built and started inside `adapter.init()`.
 *
 * The caller must call `adapter.init()` (or `sdk.init()`) before using it.
 */
export async function createChainAdapter(
  env: IntegrationEnv,
): Promise<MidnightChainAdapter> {
  const { midnight } = env;

  // Resolve seed hex (mnemonic → hex if needed).
  let seedHex: string | undefined;
  if (midnight.seed) {
    const { resolveSeedHex } = await import(
      "../../../apps/demo-console/src/wallet/index.js"
    );
    seedHex = await resolveSeedHex(
      midnight.seed.includes(" ")
        ? { mnemonic: midnight.seed }
        : { seedHex: midnight.seed },
    );
  }

  const walletNetworkId =
    midnight.network === "undeployed" ? "undeployed" : "preprod";

  const walletProvider = await buildWalletProvider(env, walletNetworkId, seedHex);

  const adapter = new MidnightChainAdapter({
    walletMode: "provider",
    network: midnight.network,
    walletProvider,
    privateStatePassword: derivePrivateStatePassword(seedHex),
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
export async function isMidnightAvailable(env: IntegrationEnv): Promise<boolean> {
  if (!env.midnight.seed) {
    console.warn("[integration] INTEGRATION_SEED not set — will skip Midnight suite.");
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

// ── Internal helpers ───────────────────────────────────────────────────────────

function derivePrivateStatePassword(seedHex: string | undefined): string {
  if (!seedHex) {
    throw new Error("Cannot derive private state password: no seed available.");
  }
  return "Aa1!" + seedHex;
}

async function buildWalletProvider(
  env: IntegrationEnv,
  walletNetworkId: string,
  seedHex: string | undefined,
) {
  // Set the network ID before building the wallet.
  const { setNetworkId } = await import(
    "@midnight-ntwrk/midnight-js-network-id"
  );
  setNetworkId(walletNetworkId);

  const { MidnightWalletProvider } = await import(
    "../../../apps/demo-console/src/wallet/wallet-provider.js"
  );

  const envConfig = {
    walletNetworkId,
    networkId: walletNetworkId,
    indexer: env.midnight.indexerEndpoint,
    indexerWS: env.midnight.indexerWsEndpoint,
    node: env.midnight.nodeEndpoint,
    nodeWS: env.midnight.nodeWsEndpoint,
    proofServer: env.proofServer,
  };

  const provider = await MidnightWalletProvider.build(envConfig, seedHex);
  await provider.start();
  return provider;
}
