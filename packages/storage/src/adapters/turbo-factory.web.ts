/**
 * @dstorage/storage — adapters/turbo-factory.web.ts
 *
 * Browser build's variant of the turbo-sdk factory loader. Swapped in for
 * ./turbo-factory.node.ts at our own build time (tsup esbuild `alias`) so the
 * browser dist never references turbo-sdk's Node build, which statically imports
 * `fs` and breaks a bundler's production build even though we only ever call
 * TurboFactory.unauthenticated().
 */
export async function getTurboFactory() {
  const { TurboFactory } = await import("@ardrive/turbo-sdk/web");
  return TurboFactory;
}
