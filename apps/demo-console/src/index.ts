/**
 * dStorage Midnight Console Demo
 *
 * A real working CLI that:
 *  1. Accepts a BIP-39 mnemonic or 32/64-byte hex seed
 *  2. Accepts an (optional) deployed DataRegistry contract address
 *  3. Initialises the DStorage SDK — which internally:
 *       a. Build chain and storage adapters
 *       b. Derives keys, builds WalletFacade, and waits for sync
 *       c. Deploys a new DataRegistry if no address was given (requires ZK artifacts)
 *       d. Derives encryption key from the seed
 *  4. Displays chain wallet addresses and balances
 *  5. Upload loop: asks for a local file path, reads its contents, calls
 *       sdk.store(content) → encrypt → mock-store → write on-chain reference
 *     and prints the refId returned by the DataRegistry circuit
 *
 * Prerequisite: run `npm run compile:contract` from packages/chain to build the
 * DataRegistry ZK artifacts before using this demo.
 */

// ── WebSocket polyfill ────────────────────────────────────────────────────────
// The Midnight indexer uses GraphQL subscriptions over WebSocket.
// Node.js doesn't expose a global WebSocket; the `ws` package fills this gap.
import WebSocket from "ws";
// @ts-expect-error — ws type doesn't perfectly match the DOM WebSocket interface
globalThis.WebSocket = WebSocket;

import { randomBytes } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "fs";
import { config as loadEnv } from "dotenv";

import {
  DStorage,
  isDStorageError,
  type Logger as DStorageLogger,
  MnemonicEncryptionAdapter,
  PasswordEncryptionAdapter,
  MockMidnightChainAdapter,
  MockStorageAdapter,
} from "@dstorage-tech/dstorage";
import { ArweaveLocalStorageAdapter } from "@dstorage/storage";
import { MidnightChainAdapter, NETWORKS } from "@dstorage/chain";
import {
  type EnvironmentConfiguration,
  resolveSeedHex,
  derivePrivateStatePassword,
  initWallet,
} from "./wallet/index.js";

import { withTicker, promptSecret } from "./common.js";
import { listReferences } from "./actions/list-references.js";
import { retrieveByRefId } from "./actions/retrieve.js";
import { removeReference } from "./actions/remove-reference.js";
import { uploadFile } from "./actions/upload.js";
import { registerMetadataOnly } from "./actions/register-metadata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the app directory (apps/demo-console/.env)
loadEnv({ path: path.resolve(__dirname, "../.env") });

const logger: DStorageLogger = {
  log: (component, msg) =>
    process.stderr.write(`[info] [${component}] ${msg}\n`),
  warn: (component, msg) =>
    process.stderr.write(`[warn] [${component}] ${msg}\n`),
  error: (component, msg) =>
    process.stderr.write(`[error] [${component}] ${msg}\n`),
  debug: (component, msg) =>
    process.stderr.write(`[debug] [${component}] ${msg}\n`),
};

// ZK artifacts for the DataRegistry contract.
// Built by running: npm run compile:contract (from packages/chain)
// Resolves to: <monorepo-root>/packages/chain/src/adapters/midnight/contracts/dataregistry/managed/
const DATA_REGISTRY_ZK_PATH = path.resolve(
  __dirname,
  "../../../packages/chain/src/adapters/midnight/contracts/dataregistry/managed",
);

// ── Network default endpoints ──────────────────────────────────────────────────
type NetworkName = keyof typeof NETWORKS;

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let rl = createInterface({ input, output });
  let chainAdapter: MidnightChainAdapter | MockMidnightChainAdapter | undefined;

  try {
    console.log("\n=== dStorage Midnight Console Demo ===\n");

    console.log(`
  ── Prerequisites ──────────────────────────────────────────────────────────────────
  Requires two local services and Preprod wallet tokens:

  1) Proof Server (port 6300)
       docker run -p 6300:6300 midnightntwrk/proof-server:8.0.3 -- midnight-proof-server -v
     Docs: https://docs.midnight.network/getting-started/installation#run-the-proof-server

  2) Arweave Local (port 1984)
       docker run -d --rm -p 1984:1984 textury/arlocal
     A pre-funded test wallet key is provided at apps/demo-console/test-arweave-wallet-key.json.

  3) Preprod tokens
     - NIGHT: https://faucet.preprod.midnight.network/
     - DUST:  open Lace → Settings → register wallet on Preprod for initial allocation
  ──────────────────────────────────────────────────────────────────────────────────────
`);

    // ── 1. Network selection ────────────────────────────────────────────────
    const networkInput = (
      await rl.question(
        "Midnight network [1=preprod (default), 2=undeployed]: ",
      )
    ).trim();
    const networkName: NetworkName =
      networkInput === "2" || networkInput === "undeployed"
        ? "undeployed"
        : networkInput === "" ||
            networkInput === "1" ||
            networkInput === "preprod"
          ? "preprod"
          : (() => {
              throw new Error(
                `Unknown network "${networkInput}". Choose 1 (preprod) or 2 (undeployed).`,
              );
            })();
    const defaultEndpoints = NETWORKS[networkName];

    console.log(`Network: ${networkName}\n`);

    // ── 2. Proof server endpoint ─────────────────────────────────────────────
    const proofServerEndpoint =
      (
        await rl.question(
          `Proof server endpoint [${defaultEndpoints.proofServer}]: `,
        )
      ).trim() || defaultEndpoints.proofServer;

    // ── 3. Mnemonic or hex seed ─────────────────────────────────────────────
    let seedRaw = process.env["DSTORAGE_SEED"]?.trim() ?? "";
    if (seedRaw) {
      console.log("\nSeed loaded from DSTORAGE_SEED env var.");
    } else {
      console.log(
        "\nEnter BIP-39 mnemonic (24 words) or hex seed (64/128 chars).",
      );
      console.log("Leave blank to auto-generate a new random seed.");
      rl.close();
      seedRaw = (await promptSecret("Mnemonic / hex seed: ")).trim();
      rl = createInterface({ input, output });
      process.stdout.write("\n");

      if (!seedRaw) {
        seedRaw = randomBytes(32).toString("hex");
        console.log("\n⚠️  A new random seed has been generated for you.");
        console.log(
          "   Save it somewhere secure — losing it means permanent loss of",
        );
        console.log("   access to your wallet and any data stored with it.\n");
        console.log(`   Seed: ${seedRaw}\n`);
      }
    }
    if (!seedRaw) throw new Error("Mnemonic or seed is required.");

    const isHex =
      /^[0-9a-fA-F]{64}$/.test(seedRaw) || /^[0-9a-fA-F]{128}$/.test(seedRaw);
    const credentials = isHex ? { seedHex: seedRaw } : { mnemonic: seedRaw };

    // ── 4. Contract address (optional) ──────────────────────────────────────
    let contractAddressInput =
      process.env["DSTORAGE_CONTRACT_ADDRESS"]?.trim() ?? "";
    if (contractAddressInput) {
      console.log(
        `\nContract address loaded from DSTORAGE_CONTRACT_ADDRESS env var: ${contractAddressInput}`,
      );
    } else {
      contractAddressInput = (
        await rl.question(
          "\nDeployed DataRegistry contract address (leave blank to auto-deploy): ",
        )
      ).trim();
    }

    // ── 5. dStorage API services prompt ─────────────────────────────────────
    console.log(`
  ── dStorage Managed Payment Service ────────────────────────────────────────────────
  The dStorage managed payment service handles both Midnight transaction and
  Arweave storage fees on your behalf. To use it you need either:
    • A dStorage Pro account — sign up or manage your account at https://dstorage.pro
    • A locally running dStorage Pro service (for testing purposes only)
  ────────────────────────────────────────────────────────────────────────────────────`);
    const useCloudApiInput = (
      await rl.question(
        `Use dStorage managed payment service? [y/N, default: N]: `,
      )
    )
      .trim()
      .toLowerCase();
    const useManagedPaymentService =
      useCloudApiInput === "y" || useCloudApiInput === "yes";
    let useManagedMock = false;

    let SIGNING_SERVER_URL = process.env["DSTORAGE_SIGNING_SERVER_URL"]?.trim();
    let authToken = process.env["DSTORAGE_AUTH_TOKEN"]?.trim();

    if (useManagedPaymentService) {
      if (!SIGNING_SERVER_URL) {
        console.log(`
  Select the service URL:
    1. dStorage Pro (https://dstorage.pro)
    2. Local testing service (http://localhost:3000) [default]
    3. Enter a custom URL`);
        const urlChoice = (
          await rl.question("  Choice [1/2/3, default: 2]: ")
        ).trim();
        if (urlChoice === "1") {
          SIGNING_SERVER_URL = "https://dstorage.pro";
        } else if (urlChoice === "3") {
          SIGNING_SERVER_URL =
            (await rl.question("  Service URL: ")).trim() ||
            "http://localhost:3000";
        } else {
          SIGNING_SERVER_URL = "http://localhost:3000";
        }
      }

      if (!authToken) {
        authToken = await promptSecret(
          "  Auth token for dStorage API service (input hidden): ",
        );
        if (!authToken) {
          throw new Error(
            "An auth token is required when using the managed payment service.",
          );
        }
      }
      console.log(`  All payments via dStorage API ${SIGNING_SERVER_URL}`);

      console.log(`
  Select payment network:
    1. Live (arweave / midnight) [default]
    2. Managed mock (TEST) — no real funds, uses mock storage and chain`);
      const netChoice = (
        await rl.question("  Choice [1/2, default: 1]: ")
      ).trim();
      useManagedMock = netChoice === "2";
    }
    const managedPaymentService = useManagedPaymentService
      ? {
          signingServerUrl: SIGNING_SERVER_URL!,
          authToken: authToken!,
        }
      : {};

    // ── 6. Build the storage adapter ──────────────────────────────────────────

    const storageAdapter = useManagedMock
      ? new MockStorageAdapter({
          signingServerUrl: SIGNING_SERVER_URL!,
          authToken: authToken!,
          logger,
        })
      : new ArweaveLocalStorageAdapter({
          walletKey: JSON.parse(
            fs.readFileSync("test-arweave-wallet-key.json", "utf8"),
          ),
          logger,
          ...managedPaymentService,
        });

    // ── 7. Build the wallet and sync ────────────────────────────────────────
    const seedHex = await resolveSeedHex(credentials);
    const envConfig: EnvironmentConfiguration = {
      networkId: networkName,
      indexerHttp: defaultEndpoints.indexerHttp,
      indexerWs: defaultEndpoints.indexerWs,
      nodeHttp: defaultEndpoints.nodeHttp,
      nodeWs: defaultEndpoints.nodeWs,
      proofServer: proofServerEndpoint,
    };

    const walletProvider = useManagedMock
      ? null
      : await initWallet(
          envConfig,
          seedHex,
          useManagedPaymentService,
          withTicker,
        );

    // ── 8. Build the chain adapter ──────────────────────────────────────────
    if (useManagedMock) {
      chainAdapter = new MockMidnightChainAdapter({
        signingServerUrl: SIGNING_SERVER_URL!,
        authToken: authToken!,
        logger,
      });
    } else {
      chainAdapter = new MidnightChainAdapter({
        logger,
        network: networkName,
        walletMode: "provider",
        walletProvider: walletProvider!,
        privateStatePassword: await derivePrivateStatePassword(seedHex),
        ...(contractAddressInput
          ? { contractAddress: contractAddressInput }
          : {}),
        proofServerEndpoint,
        // ZK artifacts for the DataRegistry storeReference circuit
        zkArtifactsPath: DATA_REGISTRY_ZK_PATH,
        ...managedPaymentService,
      });
    }

    // ── 9. Demo password for the second encryption adapter ─────────────────
    // Two encryption adapters are registered so every upload demonstrates
    // multi-key wrapping: the DEK is wrapped under both the mnemonic KEK and
    // a password KEK. Either one is enough to decrypt independently.
    let demoPassword = process.env["DSTORAGE_DEMO_PASSWORD"]?.trim() ?? "";
    if (demoPassword) {
      console.log(
        "\nDemo password loaded from DSTORAGE_DEMO_PASSWORD env var.",
      );
    } else {
      demoPassword = (
        await rl.question(
          "\nEnter a password for the demo encryption adapter (or leave blank to auto-generate): ",
        )
      ).trim();

      if (!demoPassword) {
        demoPassword = randomBytes(16).toString("hex");
        console.log("\n⚠️  A random demo password has been generated:");
        console.log(`   Password: ${demoPassword}`);
        console.log(
          "   Record it — you need it to decrypt data if you lose your seed.\n",
        );
      }
    }

    // ── 10. Initialise the DStorage SDK ─────────────────────────────────────
    // Either adapter can independently decrypt the data: recovering the mnemonic
    // is enough to regain access, and so is knowing the password. This mirrors a
    // real-world "backup recovery key" pattern without any re-encryption of the
    // stored content.
    const sdk = new DStorage({
      storageAdapter,
      chainAdapter,
      encryptionAdapters: [
        new MnemonicEncryptionAdapter(credentials),
        new PasswordEncryptionAdapter({
          password: demoPassword,
          salt: "dstorage:demo:v1",
        }),
      ],
      logger,
    });

    // sdk.init() deploys or joins the DataRegistry contract and derives the
    // encryption key from the seed. Wallet is already synced at this point.
    console.log("\nPreparing contract...");
    const dataRegistryAddress = await withTicker(
      () => "Initialising dStorage SDK...",
      () => sdk.init(),
    );
    console.log(`\nContract:   ${dataRegistryAddress}`);

    // ── 11. Display addresses and balances ──────────────────────────────────
    if (useManagedMock) {
      console.log(
        "\nManaged mock mode (TEST) — mock storage and chain, signing server handles payments.",
      );
    } else if (chainAdapter instanceof MidnightChainAdapter) {
      const addresses = chainAdapter.getAddresses();
      console.log("\nWallet addresses:");
      console.log(`  Unshielded: ${addresses.unshielded}`);
      console.log(`  Shielded:   ${addresses.shielded}`);
      console.log(`  Dust:       ${addresses.dust}`);

      if (useManagedPaymentService) {
        console.log(
          "\nManaged payment mode — wallet sync skipped, balances not shown.",
        );
      } else {
        const balances = await chainAdapter.getBalances();
        if (balances.night === 0n) {
          console.log(
            `\nNo NIGHT tokens found. Send NIGHT to:\n  ${addresses.unshielded}`,
          );
        } else {
          console.log(`\nNIGHT balance: ${balances.night}`);
        }
        if (balances.dust === 0n) {
          console.log(
            "Warning: No DUST found. DUST is required for transaction fees.",
          );
        } else {
          console.log(`DUST balance:  ${balances.dust}`);
        }
      }
    }

    // ── 12. Action loop ─────────────────────────────────────────────────────

    console.log(
      "\n─── Actions ──────────────────────────────────────────────────────────",
    );
    console.log(
      `The SDK will encrypt files, store them (${storageAdapter.providerName}), and write references on-chain (${chainAdapter.providerName}).`,
    );
    console.log(
      "You can also list references currently stored on the DataRegistry contract.\n",
    );

    let done = false;
    while (!done) {
      console.log(`
  Actions:
    1. Upload file  [default]
    2. List references
    3. Retrieve by refId
    4. Remove reference
    5. Register metadata only
    6. Quit
`);
      const action =
        (await rl.question("  Choice [1/2/3/4/5/6, default: 1]: ")).trim() ||
        "1";

      if (
        action === "6" ||
        action.toLowerCase() === "q" ||
        action.toLowerCase() === "quit"
      ) {
        done = true;
      } else if (action === "5" || action.toLowerCase() === "metadata") {
        await registerMetadataOnly(sdk, rl);
      } else if (action === "2" || action.toLowerCase() === "list") {
        await listReferences(sdk, chainAdapter);
      } else if (action === "3" || action.toLowerCase() === "retrieve") {
        await retrieveByRefId(sdk, rl);
      } else if (action === "4" || action.toLowerCase() === "remove") {
        await removeReference(sdk, chainAdapter, rl);
      } else {
        await uploadFile(sdk, storageAdapter, chainAdapter, rl);
      }
    }

    console.log("\nDone.\n");
  } finally {
    rl.close();
    if (chainAdapter) {
      console.log("Shutting down wallet...");
      //await chain.stop();
    }
  }
}

// ── Entry ──────────────────────────────────────────────────────────────────────

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = isDStorageError(error) ? ` (code: ${error.code})` : "";
    console.error(`\n[Midnight Console Demo] ${message}${code}\n`);
    process.exit(1);
  });
