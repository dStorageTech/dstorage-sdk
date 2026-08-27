/**
 * Local mock stand-in for the two external services `ArweaveBundlerStorageAdapter`
 * talks to in production:
 *
 *   - the dStorage API signing server   (POST /api/service/sign-tx)
 *   - ArDrive's Turbo bundler services  (GET /v1/price/bytes/:n, POST /v1/tx/arweave)
 *
 * Every accepted upload is relayed into a REAL Arweave L1 transaction posted to
 * arlocal, with a block mined immediately after — so arlocal itself (used
 * directly as the retrieval `gateway`) can serve it back right away. No real
 * Arweave network, ArDrive service, or funds are involved — this is purely a
 * local/offline test double.
 *
 * ── Prerequisites ────────────────────────────────────────────────────────────
 *   arlocal must already be running:
 *     docker compose -f tools/compose-undeployed.yml up -d --wait
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *   npm run bundler-mock:run
 *
 * On boot this prints an INTEGRATION_BUNDLER_AUTH_TOKEN — copy it into
 * .env.integration before running the bundler integration suites.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  generateKeyPairSync,
  createSign,
  constants as cryptoConstants,
  type KeyObject,
} from "node:crypto";
import Arweave from "arweave";
import { DataItem } from "@dha-team/arbundles";
import type { JWKInterface } from "arweave/node/lib/wallet.js";

const PORT = Number(process.env.BUNDLER_MOCK_PORT ?? 8901);
const ARLOCAL_URL =
  process.env.INTEGRATION_ARLOCAL_URL ?? "http://localhost:1984";

// ── Keypair (doubles as both the ANS-104 owner key and the arlocal wallet) ────

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 4096,
  publicExponent: 0x10001,
});

const publicJwk = publicKey.export({ format: "jwk" }) as {
  n: string;
  e: string;
};
const privateJwk = privateKey.export({ format: "jwk" }) as JWKInterface;
const ownerKeyBytes = Buffer.from(publicJwk.n, "base64url");
if (ownerKeyBytes.length !== 512) {
  throw new Error(
    `[mock-bundler] expected a 512-byte RSA-4096 modulus, got ${ownerKeyBytes.length} bytes`,
  );
}
// Node's JWK export for an RSA private key already includes kty/e/n/d/p/q/dp/dq/qi
// — the exact shape arweave-js's JWKInterface expects.
const wallet: JWKInterface = privateJwk;
const authToken = `mock-bundler-credential.${ownerKeyBytes.toString("base64url")}`;

// ── Arweave client (targets arlocal) ───────────────────────────────────────────

const arlocalUrl = new URL(ARLOCAL_URL);
const arweave = Arweave.init({
  host: arlocalUrl.hostname,
  port: Number(
    arlocalUrl.port || (arlocalUrl.protocol === "https:" ? "443" : "80"),
  ),
  protocol: arlocalUrl.protocol.replace(":", ""),
});

async function mintOnArlocal(address: string, winstons: bigint): Promise<void> {
  const res = await fetch(
    `${ARLOCAL_URL}/mint/${encodeURIComponent(address)}/${winstons.toString()}`,
  );
  if (!res.ok) {
    throw new Error(`[mock-bundler] arlocal mint failed: HTTP ${res.status}`);
  }
}

async function mineOnArlocal(): Promise<void> {
  const res = await fetch(`${ARLOCAL_URL}/mine`);
  if (!res.ok) {
    throw new Error(`[mock-bundler] arlocal mine failed: HTTP ${res.status}`);
  }
}

async function ensureFundedWallet(): Promise<void> {
  const address = await arweave.wallets.jwkToAddress(wallet);
  await mintOnArlocal(address, 10_000_000_000_000n); // 10 AR
  await mineOnArlocal(); // confirm the mint + establish a valid tx_anchor
  console.log(`[mock-bundler] funded wallet ${address} with 10 AR on arlocal`);
}

// ── Mock signing endpoint (dStorage API signing server stand-in) ──────────────

interface SignTxRequestBody {
  txData?: string; // base64url(48-byte deep_hash)
  network?: string;
  ownerKey?: string;
}

function signHash(hashBytes: Buffer, key: KeyObject): Buffer {
  // Matches @dha-team/arbundles's Rsa4096Pss.sign() exactly: sha256 digest,
  // RSA-PSS padding, default salt length — see node_modules/@dha-team/arbundles
  // build/node/cjs/src/signing/keys/Rsa4096Pss.js.
  return createSign("sha256").update(hashBytes).sign({
    key,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
  });
}

async function handleSignTx(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<SignTxRequestBody>(req);
  if (!body.txData) {
    sendJson(res, 400, { error: "missing txData" });
    return;
  }
  const hashBytes = Buffer.from(body.txData, "base64url");
  const signature = signHash(hashBytes, privateKey);
  sendJson(res, 200, {
    success: true,
    txId: "mock-signed-tx",
    signature: signature.toString("base64url"),
    publicKey: ownerKeyBytes.toString("base64url"),
    txAmount: "0",
    serviceFee: "0",
  });
}

// ── Mock ArDrive payment service stand-in ──────────────────────────────────────

function handlePriceEstimate(res: ServerResponse): void {
  sendJson(res, 200, { winc: "0" });
}

// ── Mock ArDrive upload service stand-in ────────────────────────────────────────

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readRawBody(req);
  const dataItem = new DataItem(raw);

  const valid = await dataItem.isValid().catch(() => false);
  if (!valid) {
    sendJson(res, 400, { error: "invalid ANS-104 data item signature" });
    return;
  }

  const tx = await arweave.createTransaction(
    { data: dataItem.rawData },
    wallet,
  );
  for (const tag of dataItem.tags) {
    tx.addTag(tag.name, tag.value);
  }
  await arweave.transactions.sign(tx, wallet);
  const postResult = await arweave.transactions.post(tx);
  if (postResult.status !== 200 && postResult.status !== 202) {
    sendJson(res, 502, {
      error: `arlocal rejected relayed transaction: HTTP ${postResult.status}`,
    });
    return;
  }
  await mineOnArlocal();

  console.log(`[mock-bundler] relayed data item -> arlocal tx ${tx.id}`);
  sendJson(res, 200, { id: tx.id, dataCaches: [] });
}

// ── Minimal HTTP plumbing (no new deps) ─────────────────────────────────────────

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  return raw.length ? (JSON.parse(raw.toString("utf8")) as T) : ({} as T);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

const server = createServer((req, res) => {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  const handle = async (): Promise<void> => {
    if (method === "POST" && url === "/api/service/sign-tx") {
      await handleSignTx(req, res);
    } else if (method === "GET" && /^\/v1\/price\/bytes\/\d+$/.test(url)) {
      handlePriceEstimate(res);
    } else if (method === "POST" && url === "/v1/tx/arweave") {
      await handleUpload(req, res);
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  };

  handle().catch((err: unknown) => {
    console.error("[mock-bundler] request failed:", err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err) });
  });
});

await ensureFundedWallet();

server.listen(PORT, () => {
  console.log(`[mock-bundler] listening on http://localhost:${PORT}`);
  console.log(`[mock-bundler] arlocal target: ${ARLOCAL_URL}`);
  console.log("");
  console.log("Copy this into .env.integration:");
  console.log(`INTEGRATION_BUNDLER_MOCK_SERVER_URL=http://localhost:${PORT}`);
  console.log(`INTEGRATION_BUNDLER_AUTH_TOKEN=${authToken}`);
});
