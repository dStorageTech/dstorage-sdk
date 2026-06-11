import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";

export async function withTicker<T>(
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

export function logError(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`\n  Error ${label}: ${msg}\n`);
}

export function formatBytesForConsole(bytes: Uint8Array): string {
  const looksLikeBinary = bytes.some((b) => b < 9 || (b > 13 && b < 32));
  if (looksLikeBinary) {
    const preview = Buffer.from(bytes.slice(0, 64)).toString("hex");
    const ellipsis = bytes.byteLength > 64 ? "…" : "";
    return [
      `\n  ✓ Retrieved (binary, ${bytes.byteLength} bytes)`,
      `  Hex preview (first 64 bytes): ${preview}${ellipsis}`,
      "",
    ].join("\n");
  }
  const decoded = new TextDecoder().decode(bytes);
  const preview = decoded.slice(0, 512);
  const truncated = decoded.length > 512 ? "…" : "";
  return [
    `\n  ✓ Retrieved (${bytes.byteLength} bytes):`,
    "  ─────────────────────────────────────",
    `  ${preview}${truncated}`,
    "  ─────────────────────────────────────",
    "",
  ].join("\n");
}

export async function promptMetadata(
  rl: Interface,
): Promise<Record<string, string> | undefined> {
  const metaRaw = (
    await rl.question(
      "  Metadata (key1=val1,key2=val2,... or leave blank to skip): ",
    )
  ).trim();
  if (!metaRaw) return undefined;
  const entries: Record<string, string> = {};
  for (const pair of metaRaw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) entries[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

export async function promptSecret(prompt: string): Promise<string> {
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
