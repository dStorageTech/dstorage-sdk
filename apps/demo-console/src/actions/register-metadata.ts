import { type Interface } from "node:readline/promises";
import { type DStorage } from "@dstorage-tech/dstorage-sdk";
import { withTicker, logError, promptMetadata } from "../common.js";

export async function registerMetadataOnly(
  sdk: DStorage,
  rl: Interface,
): Promise<void> {
  const metadata = await promptMetadata(rl);
  if (metadata === undefined) {
    console.log("  (cancelled)\n");
    return;
  }

  try {
    const result = await withTicker(
      () => "Registering metadata-only reference on-chain...",
      () => sdk.registerReference({ metadata }),
    );
    console.log("\n  ✓ Metadata reference registered!");
    console.log(`  refId: ${result.chainRefId}\n`);
  } catch (err) {
    logError("registering metadata", err);
  }
}
