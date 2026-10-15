<img src="https://raw.githubusercontent.com/dStorageTech/dstorage-sdk/main/docs/dStorage-logo-image-monochrome.png" alt="dStorage logo" width="80" />

# dStorage SDK

[![npm](https://img.shields.io/npm/v/@dstorage-tech/dstorage-sdk.svg)](https://www.npmjs.com/package/@dstorage-tech/dstorage-sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/dStorageTech/dstorage-sdk/blob/main/LICENSE)

> Privacy-first data layer for dApps — client-side encryption + decentralised storage + on-chain coordination in a single SDK.

> ⚠️ **Pre-1.0, active development**: APIs may still change between minor versions.

## 📖 [Full documentation on GitHub →](https://github.com/dStorageTech/dstorage-sdk#readme)

🌐 Website: [dstorage.pro](https://dstorage.pro)

## Guides & AI prompts

Step-by-step guides live at **[dstorage.pro/docs](https://dstorage.pro/docs/guide/)**: mock adapters, local & simulator setup, the Midnight network adapter, passkey encryption, managed payments, and an FAQ.

Building with an AI coding agent (Claude Code, Cursor, Codex, ...)? Visit the [Build with AI](https://dstorage.pro/docs/guide/build-with-ai.html) page on the website. It has a ready-made prompt for every guide and explains how to point your agent at the current docs. The SDK is new and its API changes between versions, so an agent's memory of it is often wrong.

## Install

```sh
npm install @dstorage-tech/dstorage-sdk
```

Requires Node.js 22+. The same package works in the browser — see [Browser Usage](https://github.com/dStorageTech/dstorage-sdk#browser-usage).

## Quick example

```typescript
import {
  DStorage,
  MockStorageAdapter,
  MockChainAdapter,
  PasswordEncryptionAdapter,
} from "@dstorage-tech/dstorage-sdk";

const sdk = new DStorage({
  storageAdapters: [new MockStorageAdapter()], // or ArweaveStorageAdapter, ArweaveBundlerStorageAdapter, ...
  chainAdapters: [new MockChainAdapter()], // or MidnightChainAdapter
  encryptionAdapters: [
    new PasswordEncryptionAdapter({
      password: "correct-horse-battery-staple",
      salt: "myapp:v1:alice@example.com",
    }),
  ],
});
await sdk.init();

const { chainRefId } = await sdk.store(
  new TextEncoder().encode("Hello dStorage!"),
);
const { bytes } = await sdk.retrieveByRefId(chainRefId!);
console.log(new TextDecoder().decode(bytes)); // "Hello dStorage!"
```

## Learn more

- [Quick Start & adapters](https://github.com/dStorageTech/dstorage-sdk#quick-start)
- [Managing references](https://github.com/dStorageTech/dstorage-sdk#managing-references): list, update, remove, rotate keys
- [Browser usage](https://github.com/dStorageTech/dstorage-sdk#browser-usage)
- [Midnight ZK artifacts](https://github.com/dStorageTech/dstorage-sdk#midnight-zk-artifacts)
- [Error handling](https://github.com/dStorageTech/dstorage-sdk#error-handling)
- [Encryption design](https://github.com/dStorageTech/dstorage-sdk#encryption-design)
- [dStorage website](https://dstorage.pro) · [Guides](https://dstorage.pro/docs/guide/) · [FAQ](https://dstorage.pro/docs/faq/)
- [Issues](https://github.com/dStorageTech/dstorage-sdk/issues) · [Security policy](https://github.com/dStorageTech/dstorage-sdk/blob/main/SECURITY.md)

## License

MIT
