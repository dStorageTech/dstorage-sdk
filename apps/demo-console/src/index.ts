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
 *       d. Derives an AES-GCM encryption key from the seed
 *  4. Displays chain wallet addresses and balances
 *  5. Upload loop: asks for a local file path, reads its contents, calls
 *       sdk.upload(content) → encrypt → mock-store → write on-chain reference
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

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fs from "fs";
import pino from "pino";

import { DStorage, type Logger as DStorageLogger } from "@dstorage/core";
import {
  ArweaveLocalStorageAdapter,
  //MockStorageAdapter,
} from "@dstorage/storage";
import { MidnightChainAdapter } from "@dstorage/chain";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fmt = (args: unknown[]) =>
  args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
const logger: DStorageLogger = {
  log: (...args) => process.stderr.write(`[info] ${fmt(args)}\n`),
  warn: (...args) => process.stderr.write(`[warn] ${fmt(args)}\n`),
  error: (...args) => process.stderr.write(`[error] ${fmt(args)}\n`),
  debug: (...args) => process.stderr.write(`[debug] ${fmt(args)}\n`),
};

// ZK artifacts for the DataRegistry contract.
// Built by running: npm run compile:contract (from packages/chain)
// Resolves to: <monorepo-root>/packages/chain/src/adapters/midnight/contracts/dataregistry/managed/
const DATA_REGISTRY_ZK_PATH = path.resolve(
  __dirname,
  "../../../packages/chain/src/adapters/midnight/contracts/dataregistry/managed",
);

// ── Network defaults ───────────────────────────────────────────────────────────

const NETWORKS = {
  preprod: {
    node: "https://rpc.preprod.midnight.network",
    nodeWs: "wss://rpc.preprod.midnight.network",
    indexerHttp: "https://indexer.preprod.midnight.network/api/v3/graphql",
    indexerWs: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
    proofServer: "http://127.0.0.1:6300",
  },
  undeployed: {
    node: "https://127.0.0.1:9944",
    nodeWs: "wss://127.0.0.1:9944",
    indexerHttp: "http://127.0.0.1:8088/api/v3/graphql",
    indexerWs: "ws://127.0.0.1:8088/api/v3/graphql/ws",
    proofServer: "http://127.0.0.1:6300",
  },
} as const;

type NetworkName = keyof typeof NETWORKS;

// ── Progress ticker ────────────────────────────────────────────────────────────

async function withTicker<T>(
  statusLine: () => string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const id = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  ${statusLine()} (${elapsed}s)`);
  }, 3000);
  try {
    return await fn();
  } finally {
    clearInterval(id);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let rl = createInterface({ input, output });
  let chainAdapter: MidnightChainAdapter | undefined;

  try {
    console.log("\n=== dStorage Midnight Console Demo ===\n");

    // ── 1. Network selection ────────────────────────────────────────────────
    const networkInput =
      (
        await rl.question(
          "Midnight network [preprod / undeployed, default: preprod]: ",
        )
      ).trim() || "preprod";
    if (networkInput !== "preprod" && networkInput !== "undeployed") {
      throw new Error(
        `Unknown network "${networkInput}". Choose preprod or undeployed.`,
      );
    }
    const networkName = networkInput as NetworkName;
    const defaults = NETWORKS[networkName];

    console.log(`Network: ${networkName}\n`);

    // ── 2. Endpoints ────────────────────────────────────────────────────────
    const nodeEndpoint =
      (await rl.question(`Node RPC endpoint [${defaults.node}]: `)).trim() ||
      defaults.node;
    const nodeWsEndpoint =
      (await rl.question(`Node WS endpoint [${defaults.nodeWs}]: `)).trim() ||
      defaults.nodeWs;
    const indexerHttp =
      (
        await rl.question(`Indexer HTTP endpoint [${defaults.indexerHttp}]: `)
      ).trim() || defaults.indexerHttp;
    const indexerWs =
      (
        await rl.question(`Indexer WS endpoint [${defaults.indexerWs}]: `)
      ).trim() || defaults.indexerWs;
    const proofServerEndpoint =
      (
        await rl.question(`Proof server endpoint [${defaults.proofServer}]: `)
      ).trim() || defaults.proofServer;

    // ── 3. Mnemonic or hex seed ─────────────────────────────────────────────
    console.log(
      "\nEnter BIP-39 mnemonic (12/24 words) or hex seed (64/128 chars).",
    );
    rl.close();
    const seedInput = await promptSecret("Mnemonic / hex seed: ");

    rl = createInterface({ input, output });
    process.stdout.write("\n");
    if (!seedInput) throw new Error("Mnemonic or seed is required.");

    const trimmed = seedInput.trim();
    const isHex =
      /^[0-9a-fA-F]{64}$/.test(trimmed) || /^[0-9a-fA-F]{128}$/.test(trimmed);
    const credentials = isHex ? { seedHex: trimmed } : { mnemonic: trimmed };

    // ── 4. Contract address (optional) ──────────────────────────────────────
    const contractAddressInput = (
      await rl.question(
        "\nDeployed DataRegistry contract address (leave blank to auto-deploy): ",
      )
    ).trim();

    // ── 5. Build the storage adapter ──────────────────────────────────────────
    //const storageAdapter = new MockStorageAdapter();
    const storageAdapter = new ArweaveLocalStorageAdapter({
      walletKey: JSON.parse(
        fs.readFileSync("test-arweave-wallet-key.json", "utf8"),
      ),
    });

    // ── 6. Build the chain adapter ──────────────────────────────────────────
    chainAdapter = new MidnightChainAdapter({
      network: networkName,
      walletMode: "facade",
      credentials,
      ...(contractAddressInput
        ? { contractAddress: contractAddressInput }
        : {}),
      nodeEndpoint,
      nodeWsEndpoint,
      indexerEndpoint: indexerHttp,
      indexerWsEndpoint: indexerWs,
      proofServerEndpoint,
      // ZK artifacts for the DataRegistry storeReference circuit
      zkArtifactsPath: DATA_REGISTRY_ZK_PATH,
    });

    // ── 7. Initialise the DStorage SDK ──────────────────────────────────────
    const sdk = new DStorage({
      storageAdapter,
      chainAdapter,
      logger,
      ...(contractAddressInput
        ? { dataRegistryAddress: contractAddressInput }
        : {}),
    });

    // sdk.init() calls chain.init() (wallet sync), then sets/deploys the contract,
    // and derives an AES-GCM encryption key from the seed.
    console.log("\nInitialising wallet, syncing, and preparing contract...");
    const dataRegistryAddress = await withTicker(
      () => "Building wallet and syncing...",
      () => sdk.init(),
    );
    console.log(`\nContract:   ${dataRegistryAddress}`);

    // ── 8. Display addresses and balances ───────────────────────────────────
    const addresses = chainAdapter.getAddresses();
    console.log("\nWallet addresses:");
    console.log(`  Unshielded: ${addresses.unshielded}`);
    console.log(`  Shielded:   ${addresses.shielded}`);
    console.log(`  Dust:       ${addresses.dust}`);

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

    // ── 9. Action loop: upload files or list DataRegistry references ───────

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
      const action =
        (
          await rl.question(
            "\nChoose action [1=upload file, 2=list references, 3=retrieve by refId, 4=quit, default: 1]: ",
          )
        ).trim() || "1";

      if (
        action === "4" ||
        action.toLowerCase() === "q" ||
        action.toLowerCase() === "quit"
      ) {
        done = true;
        continue;
      }

      if (action === "2" || action.toLowerCase() === "list") {
        try {
          const refs = await sdk.listReferences();
          console.log(
            `\n  Stored references on contract ${chainAdapter.getContractAddress()}: ${refs.length}`,
          );
          if (refs.length === 0) {
            console.log("  (none)\n");
            continue;
          }
          for (let i = 0; i < refs.length; i += 1) {
            const ref = refs[i]!;
            console.log(`  [${i + 1}] refId = ${ref.refId}`);
            console.log(`      storageProvider = ${ref.storageProvider}`);
            console.log(`      storageId = ${ref.storageId}`);
          }
          console.log("");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`\n  Error listing references: ${msg}\n`);
        }
        continue;
      }

      if (action === "3" || action.toLowerCase() === "retrieve") {
        const refId = (await rl.question("  Enter refId to retrieve: ")).trim();
        if (!refId) {
          console.log("  (cancelled)\n");
          continue;
        }

        try {
          console.log(`\n  Resolving on-chain reference for refId: ${refId}`);
          const result = await withTicker(
            () =>
              "Fetching reference from chain and retrieving from storage...",
            () => sdk.retrieveByRefId(refId),
          );

          const outputPath = (
            await rl.question(
              "  Save to file (leave blank to print to console): ",
            )
          ).trim();

          if (outputPath) {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(outputPath, result.bytes);
            console.log(`\n  ✓ Retrieved and saved to: ${outputPath}`);
            console.log(`  Size: ${result.bytes.byteLength} bytes\n`);
          } else {
            // Print as text; if it looks like binary data, show a hex preview
            const looksLikeBinary = result.bytes.some(
              (b) => b < 9 || (b > 13 && b < 32),
            );
            if (looksLikeBinary) {
              const preview = Buffer.from(result.bytes.slice(0, 64)).toString(
                "hex",
              );
              console.log(
                `\n  ✓ Retrieved (binary, ${result.bytes.byteLength} bytes)`,
              );
              console.log(
                `  Hex preview (first 64 bytes): ${preview}${result.bytes.byteLength > 64 ? "…" : ""}\n`,
              );
            } else {
              const preview = result.content.slice(0, 512);
              const truncated = result.content.length > 512 ? "…" : "";
              console.log(
                `\n  ✓ Retrieved (${result.bytes.byteLength} bytes):`,
              );
              console.log("  ─────────────────────────────────────");
              console.log(`  ${preview}${truncated}`);
              console.log("  ─────────────────────────────────────\n");
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`\n  Error during retrieve: ${msg}\n`);
        }
        continue;
      }

      const filePath = (
        await rl.question("File path to upload (or leave blank to cancel): ")
      ).trim();
      if (!filePath) continue;

      // Read file from disk
      let fileContent: Uint8Array;
      try {
        const buf = await readFile(filePath);
        fileContent = new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Error reading file: ${msg}`);
        continue;
      }

      console.log(
        `\n  File: ${path.basename(filePath)} (${fileContent.byteLength} bytes)`,
      );
      console.log(
        `  Uploading to ${storageAdapter.name} storage and writing on-chain (${chainAdapter.name}) reference...`,
      );

      try {
        const result = await withTicker(
          () => "Generating ZK proof and submitting reference...",
          () => sdk.upload(fileContent),
        );

        console.log("\n  ✓ Upload complete!");
        console.log(`  refId:           ${result.chainRefId}`);
        console.log(`  storageId:       ${result.storageId}`);
        console.log(`  storageProvider: ${result.storageProvider}`);
        console.log(`  chainProvider:   ${result.chainProvider}`);
        console.log(
          `  uploadedAt:      ${new Date(result.uploadedAt).toISOString()}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n  Error during upload: ${msg}\n`);
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

// ── Masked input ───────────────────────────────────────────────────────────────

async function promptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const fallback = createInterface({ input, output });
    try {
      return (await fallback.question(prompt)).trim();
    } finally {
      fallback.close();
    }
  }

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const out = process.stdout;

    out.write(prompt);

    let value = "";

    const onData = (chunk: Buffer): void => {
      const str = chunk.toString("utf8");

      if (str === "\r" || str === "\n") {
        cleanup();
        out.write("\n");
        resolve(value);
        return;
      }

      if (str === "\u0003") {
        cleanup();
        reject(new Error("Input cancelled."));
        return;
      }

      if (str === "\u007f" || str === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          out.write("\b \b");
        }
        return;
      }

      value += str;
      out.write("*".repeat(str.length));
    };

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// ── Entry ──────────────────────────────────────────────────────────────────────

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[Midnight Console Demo] ${message}\n`);
    process.exit(1);
  });
