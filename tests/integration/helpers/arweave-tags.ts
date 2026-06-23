/** Decode a base64url-encoded Arweave tag name or value to a plain string. */
function fromBase64Url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** Decode a raw Arweave tx tag array to a plain Record<string,string>. */
export function decodeArweaveTags(
  tags: Array<{ name: string; value: string }>,
): Record<string, string> {
  return Object.fromEntries(
    tags.map(({ name, value }) => [fromBase64Url(name), fromBase64Url(value)]),
  );
}

/** Fetch decoded tags for an arlocal tx by its storage ID (= Arweave tx ID). */
export async function fetchTxTags(
  arlocalUrl: string,
  txId: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${arlocalUrl}/tx/${txId}`);
  const tx = (await res.json()) as {
    tags: Array<{ name: string; value: string }>;
  };
  return decodeArweaveTags(tx.tags);
}
