/**
 * @dstorage/storage — adapters/turbo-factory.ts
 *
 * Node build's (default) variant of the turbo-sdk factory loader. The browser
 * build swaps this out for ./turbo-factory.web.ts at our own build time (tsup
 * esbuild `alias`), never at runtime — a bundler's production build statically
 * resolves every import() it finds, so the platform choice has to be baked into
 * the dist we ship, not decided with a `typeof window` check.
 */
export async function getTurboFactory() {
  const { TurboFactory } = await import("@ardrive/turbo-sdk/node");
  return TurboFactory;
}
