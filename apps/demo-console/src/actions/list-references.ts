import { type DStorage } from "@dstorage-tech/dstorage";
import { type MidnightChainAdapter } from "@dstorage/chain";
import { logError } from "../common.js";

export async function listReferences(
  sdk: DStorage,
  chainAdapter: MidnightChainAdapter,
): Promise<void> {
  try {
    const refs = await sdk.listReferences();
    console.log(
      `\n  Stored references on contract ${chainAdapter.getContractAddress()}: ${refs.length}`,
    );
    if (refs.length === 0) {
      console.log("  (none)\n");
      return;
    }
    for (let i = 0; i < refs.length; i += 1) {
      const ref = refs[i]!;
      const scheme = ref.encryptionScheme || null;
      console.log(`  [${i + 1}] refId = ${ref.refId}`);
      console.log(`      storageProvider  = ${ref.storageProvider}`);
      console.log(
        `      encryptionScheme = ${scheme ?? "(public/unencrypted)"}`,
      );
      console.log(
        `      storageId        = ${ref.storageId ?? "(cannot decrypt)"}`,
      );
      console.log(
        `      owned            = ${ref.decryptionError === undefined ? "Yes" : `No (${ref.decryptionError})`}`,
      );
    }
    console.log("");
  } catch (err) {
    logError("listing references", err);
  }
}
