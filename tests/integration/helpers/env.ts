/**
 * Reads integration test configuration from environment variables.
 * All variables are optional with sensible defaults; the helpers will
 * call vi.skip() at runtime if required services are unavailable.
 */

export type MidnightNetwork = "preprod" | "undeployed";

export interface IntegrationEnv {
  arlocalUrl: string;
  proofServer: string;
  midnight: {
    network: MidnightNetwork;
    nodeEndpoint: string;
    nodeWsEndpoint: string;
    indexerEndpoint: string;
    indexerWsEndpoint: string;
    seed: string | undefined;
    contractAddress: string | undefined;
  };
}

export function readEnv(): IntegrationEnv {
  const network =
    (process.env.INTEGRATION_MIDNIGHT_NETWORK as MidnightNetwork) ?? "preprod";

  const defaultEndpoints =
    network === "undeployed"
      ? {
          node: "http://127.0.0.1:9944",
          nodeWs: "ws://127.0.0.1:9944",
          indexer: "http://127.0.0.1:8088/api/v4/graphql",
          indexerWs: "ws://127.0.0.1:8088/api/v4/graphql/ws",
        }
      : {
          node: "https://rpc.preprod.midnight.network",
          nodeWs: "wss://rpc.preprod.midnight.network",
          indexer: "https://indexer.preprod.midnight.network/api/v4/graphql",
          indexerWs: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
        };

  return {
    arlocalUrl: process.env.INTEGRATION_ARLOCAL_URL ?? "http://localhost:1984",
    proofServer:
      process.env.INTEGRATION_PROOF_SERVER ?? "http://localhost:6300",
    midnight: {
      network,
      nodeEndpoint:
        process.env.INTEGRATION_NODE_ENDPOINT ?? defaultEndpoints.node,
      nodeWsEndpoint:
        process.env.INTEGRATION_NODE_WS_ENDPOINT ?? defaultEndpoints.nodeWs,
      indexerEndpoint:
        process.env.INTEGRATION_INDEXER_ENDPOINT ?? defaultEndpoints.indexer,
      indexerWsEndpoint:
        process.env.INTEGRATION_INDEXER_WS_ENDPOINT ??
        defaultEndpoints.indexerWs,
      seed: process.env.INTEGRATION_SEED || undefined,
      contractAddress: process.env.INTEGRATION_CONTRACT_ADDRESS || undefined,
    },
  };
}
