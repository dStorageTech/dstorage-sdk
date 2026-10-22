import { readFile } from "node:fs/promises";
import { type Interface } from "node:readline/promises";
import path from "node:path";
import {
  type DStorage,
  type StorageAdapter,
  type ChainAdapter,
} from "@dstorage-tech/dstorage-sdk";
import { withTicker, logError, promptMetadata } from "../common.js";

export async function uploadFile(
  sdk: DStorage,
  storageAdapter: StorageAdapter,
  chainAdapter: ChainAdapter,
  rl: Interface,
): Promise<void> {
  const filePath = (
    await rl.question("File path to upload (or leave blank to cancel): ")
  ).trim();
  if (!filePath) return;

  let fileContent: Uint8Array;
  try {
    const buf = await readFile(filePath);
    fileContent = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    logError("reading file", err);
    return;
  }

  const replaceInput = (
    await rl.question("  Replace an existing reference? [y/N]: ")
  )
    .trim()
    .toLowerCase();
  const isReplacing = replaceInput === "y" || replaceInput === "yes";

  let replaceRefId: string | undefined;
  if (isReplacing) {
    replaceRefId =
      (await rl.question("  Enter refId to replace: ")).trim() || undefined;
  }

  // Updates are always encrypted, so only new uploads can be public.
  let isPublic = false;
  if (replaceRefId) {
    console.log("  (updates are always private — content will be encrypted)");
  } else {
    const visibilityInput = (
      await rl.question("  Upload as [1=private (default), 2=public]: ")
    ).trim();
    isPublic =
      visibilityInput === "2" || visibilityInput.toLowerCase() === "public";
  }

  // Metadata prompt (only for private uploads — metadata is encrypted with the DEK)
  const metadata = isPublic ? undefined : await promptMetadata(rl);

  console.log(
    `\n  File: ${path.basename(filePath)} (${fileContent.byteLength} bytes) [${isPublic ? "public" : "private"}]`,
  );

  try {
    if (replaceRefId) {
      console.log(
        `  Updating reference ${replaceRefId} on ${chainAdapter.name}...`,
      );
      const result = await withTicker(
        () => `Updating reference ${replaceRefId}...`,
        () =>
          sdk.update(replaceRefId!, fileContent, {
            ...(metadata !== undefined && { metadata }),
          }),
      );
      console.log("\n  ✓ Update complete!");
      console.log(`  refId:     ${result.chainRefId}`);
      console.log(`  storageId: ${result.storageId}\n`);
    } else {
      console.log(
        `  Uploading to ${storageAdapter.name} storage and writing on-chain (${chainAdapter.name}) reference...`,
      );
      const result = await withTicker(
        () => "Generating ZK proof and submitting reference...",
        () =>
          sdk.store(fileContent, {
            isPublic,
            ...(metadata !== undefined && { metadata }),
          }),
      );

      const visibility = result.encryptionScheme
        ? "private (encrypted)"
        : "public (unencrypted)";
      console.log("\n  ✓ Upload complete!");
      console.log(`  refId:            ${result.chainRefId}`);
      console.log(`  storageId:        ${result.storageId}`);
      console.log(`  storageProvider:  ${result.storageProvider}`);
      console.log(`  chainProvider:    ${result.chainProvider}`);
      console.log(`  encryptionScheme: ${result.encryptionScheme || "(none)"}`);
      console.log(`  visibility:       ${visibility}`);
      console.log(
        `  uploadedAt:       ${new Date(result.uploadedAt).toISOString()}\n`,
      );
    }
  } catch (err) {
    logError("during upload", err);
  }
}
