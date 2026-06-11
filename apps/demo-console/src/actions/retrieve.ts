import { type Interface } from "node:readline/promises";
import { type DStorage } from "@dstorage-tech/dstorage";
import { withTicker, logError, formatBytesForConsole } from "../common.js";

export async function retrieveByRefId(
  sdk: DStorage,
  rl: Interface,
): Promise<void> {
  const refId = (await rl.question("  Enter refId to retrieve: ")).trim();
  if (!refId) {
    console.log("  (cancelled)\n");
    return;
  }

  try {
    console.log(`\n  Resolving on-chain reference for refId: ${refId}`);
    const result = await withTicker(
      () => "Fetching reference from chain and retrieving from storage...",
      () => sdk.retrieveByRefId(refId),
    );

    const outputPath = (
      await rl.question("  Save to file (leave blank to print to console): ")
    ).trim();

    // Show metadata (decrypted on-chain) if present
    const metaEntries = Object.entries(result.metadata ?? {});
    if (metaEntries.length > 0) {
      console.log("  On-chain Metadata:");
      for (const [k, v] of metaEntries) console.log(`    ${k}: ${v}`);
    }

    // Show storage tags if present
    const tagEntries = Object.entries(result.tags ?? {});
    if (tagEntries.length > 0) {
      console.log("  Storage Tags:");
      for (const [k, v] of tagEntries) console.log(`    ${k}: ${v}`);
    }

    if (outputPath) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputPath, result.bytes);
      console.log(`\n  ✓ Retrieved and saved to: ${outputPath}`);
      console.log(`  Size: ${result.bytes.byteLength} bytes\n`);
    } else {
      console.log(formatBytesForConsole(result.bytes));
    }
  } catch (err) {
    logError("during retrieve", err);
  }
}
