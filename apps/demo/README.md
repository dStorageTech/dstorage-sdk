# HealthVault — dStorage SDK Demo

HealthVault is a browser demo showing how the dStorage SDK works end-to-end. It simulates a patient uploading an insurance card, encrypting it, storing it on a decentralised backend, and then generating a ZK proof that proves insurance coverage to a clinic — without the clinic ever seeing the underlying file.

The whole point is to make the SDK's core promise tangible: data stays private, only the owner controls access, and claims can be verified without revealing anything.

## Running the demo

```bash
npm run dev -w apps/demo
# → http://localhost:5173
```

No wallet extension is required for the default mock flow.

## What to look for

### Start options + storage adapter switcher

On the first screen, the demo provides two paths:
- **A** Upload a new health insurance certificate
- **B** Go directly to proof generation from a mock list of previously uploaded certificates

You can also pick a storage backend:

| Adapter | Status | What it does |
|---|---|---|
| **Mock** | Live | Stores encrypted blobs in memory — no network, instant |
| **Arweave Local** | Live | Real Arweave transaction flow against a local [arlocal](https://github.com/textury/arlocal) node — no AR tokens needed |
| **Arweave** | Preview | Uploads to the Arweave permaweb (requires ArConnect extension) |
| **Autonomi** | Stub | Autonomi network — memory-backed until JS SDK is stable |

Switching between them is a single line change in application code:

```typescript
// Mock — for development
storageAdapter: new MockStorageAdapter()

// Arweave Local — integration testing with a local arlocal node
// Start: docker run -d --rm -p 1984:1984 textury/arlocal
//    or: npx arlocal
storageAdapter: new ArweaveLocalStorageAdapter()

// Arweave — pay-once permanent storage
storageAdapter: new ArweaveStorageAdapter()

// Autonomi — decentralised, self-encrypting
storageAdapter: new AutonomiStorageAdapter()
```

The SDK takes care of everything else: encryption, cost estimation, on-chain references, access control. The application logic doesn't change.

### The SDK drawer

The slide-up panel at the bottom of the screen shows what the SDK is doing in real time:

- **Before a transaction**: displays the active adapter configuration
- **During upload**: the full meta-transaction pipeline — estimate → encrypt → pay storage → upload → pay chain → write reference
- **During proof**: the ZK proof pipeline — read record → generate witness → run circuit → commit on-chain

This is what `executeMetaTransaction` looks like from the inside.

### Privacy guarantee

The file you upload is encrypted on your device before it leaves. The storage adapter — whichever you choose — only ever receives ciphertext. The on-chain reference holds a storage ID and owner address, not the data. The ZK proof the clinic receives proves a claim about the record without revealing its contents.

## Architecture

```
HealthVault (React)
    │
    └── DStorage SDK (@dstorage/core)
            ├── @dstorage/crypto   — AES-GCM encryption, key derivation
            ├── @dstorage/storage  — MockStorageAdapter / ArweaveStorageAdapter / AutonomiStorageAdapter
            ├── @dstorage/chain    — MockMidnightChainAdapter (simulated ZK proofs)
            └── @dstorage/payment  — MockPaymentAdapter (simulated fees)
```

## File structure

```
apps/demo/src/
  App.tsx              — root state, adapter selection, SDK wiring
  components/
    PatientPanel.tsx   — choose path, pick adapters, upload, upload summary, generate proof
    VerifierPanel.tsx  — receive and display the ZK proof result
    SdkDrawer.tsx      — live SDK activity feed + adapter config display
  index.css            — all styles
```
