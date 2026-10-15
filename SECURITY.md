# Security Policy

dStorage is a privacy and encryption SDK, so we take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Report them privately through GitHub's [private vulnerability reporting](https://github.com/dStorageTech/dstorage-sdk/security/advisories/new) ("Report a vulnerability" under the repository's **Security** tab).

Please include as much of the following as you can:

- the affected package version(s) and adapter(s) (e.g. `PasswordEncryptionAdapter`, `MidnightChainAdapter` in connector mode)
- a description of the issue and its impact (e.g. plaintext or key disclosure, ownership bypass, integrity bypass)
- step-by-step reproduction, or a proof-of-concept
- any suggested fix or mitigation

We will acknowledge your report, keep you informed while we investigate, and credit you in the advisory once a fix is released (unless you prefer to remain anonymous).

## Supported versions

The SDK is pre-1.0. Security fixes are released for the **latest published minor version** of [`@dstorage-tech/dstorage-sdk`](https://www.npmjs.com/package/@dstorage-tech/dstorage-sdk) only. Please upgrade to the latest version before reporting.

| Version      | Supported |
| ------------ | :-------: |
| latest `0.x` |    ✅     |
| older `0.x`  |    ❌     |

## Scope

In scope:

- the SDK packages in this repository (`packages/*`), published as `@dstorage-tech/dstorage-sdk`
- the `DataRegistry` Compact contract (`packages/chain/src/adapters/midnight/contracts/`)

Out of scope:

- the demo apps (`apps/*`) and development tooling (`tools/*`), unless the issue also affects the SDK
- vulnerabilities in third-party dependencies or networks (Midnight, Arweave, wallet extensions); please report those upstream, though we'd like to hear about them if they affect dStorage users
- issues that require an already-compromised user device or leaked user credentials (password, mnemonic, secret key, passkey)

## Known limitations

Documented design limitations, such as the missing response MAC in `ManagedPaymentAdapter`, are listed under [Known Limitations](README.md#known-limitations) in the README. Reports that meaningfully extend or exploit them are still welcome.
