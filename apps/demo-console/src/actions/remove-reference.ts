import { type Interface } from "node:readline/promises";
import { type DStorage, type ChainAdapter } from "@dstorage-tech/dstorage-sdk";
import { withTicker, logError } from "../common.js";

export async function removeReference(
  sdk: DStorage,
  chainAdapter: ChainAdapter,
  rl: Interface,
): Promise<void> {
  const refId = (
    await rl.question("  Enter refId to remove (or leave blank to cancel): ")
  ).trim();
  if (!refId) {
    console.log("  (cancelled)\n");
    return;
  }

  try {
    console.log(`\n  Looking up reference ${refId}…`);
    const ref = await chainAdapter.readReference(refId);
    console.log(`     refId:         ${refId}`);
    console.log(`  storageProvider:  ${ref.storageProvider}`);
    console.log(
      `  encryptionScheme: ${ref.encryptionScheme ?? "(public/unencrypted)"}`,
    );
    console.log(`  storageId:        ${ref.storageId}`);
    console.log(`  writtenAt:        ${new Date(ref.writtenAt).toISOString()}`);
  } catch (err) {
    logError("reading reference", err);
    return;
  }

  const confirmInput = (await rl.question("  Remove this reference? [y/N]: "))
    .trim()
    .toLowerCase();
  if (confirmInput !== "y" && confirmInput !== "yes") {
    console.log("  (cancelled)\n");
    return;
  }

  try {
    await withTicker(
      () => "Submitting remove reference transaction…",
      () => sdk.removeReference(refId),
    );
    console.log("\n  ✓ Reference removed.\n");
  } catch (err) {
    logError("removing reference", err);
  }
}
