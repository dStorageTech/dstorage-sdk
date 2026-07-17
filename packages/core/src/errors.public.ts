// Dependency-free error surface. Every symbol here resolves to a pure,
// zero-import module (chain/storage's own "./errors" subpaths, crypto's
// lightweight index, core's own errors.ts) — never chain's Node-only
// MidnightChainAdapter or storage's arweave adapters. Any bundler,
// in any environment, can import this entry point without pulling in
// adapter code that may fail to load outside its target platform.
export {
  CryptoErrorCode,
  DStorageError,
  isDStorageError,
} from "@dstorage/crypto";
export { StorageErrorCode } from "@dstorage/storage/errors";
export { ChainErrorCode } from "@dstorage/chain/errors";
export {
  CoreErrorCode,
  StorePartialError,
  isStorePartialError,
} from "./errors.js";
