/**
 * dStorage SDK — Basic Flow Example
 *
 * Demonstrates the three-component mock setup:
 *   - Mocked wallet   (connectDemoWallet)
 *   - Mocked Midnight blockchain network + proof server  (MockMidnightChainAdapter)
 *   - Mocked decentralised storage network               (MockStorageAdapter)
 *
 * Run with:
 *   npm run example
 *
 * Expected output (timings will vary):
 *   [dStorage] Demo wallet connected  →  address: 0xAlice...
 *   [dStorage/mock-midnight] writeReference → calling proof server…
 *   [dStorage/proof-server] Generating proof for circuit "storeReference"…
 *   [dStorage/proof-server] Proof generated in 412ms ✓
 *   [dStorage/mock-midnight] Submitting balanced tx to Midnight node…
 *   [dStorage/mock-midnight] Reference written at block 1005423 → refId: ref_…
 *   Uploaded dataId: mock_…::ref_…
 *   Retrieved content: {"patient":"Alice","plan":"Gold","active":true}
 *   Bob has access: false
 *   [dStorage/mock-midnight] grantAccess → calling proof server…
 *   Bob has access after grant: true
 *   Bob has access after revoke: false
 */

import {
  DStorage,
  connectDemoWallet,
  MockMidnightChainAdapter,
} from '@dstorage/core';
import { MockStorageAdapter } from '@dstorage/storage';

async function main(): Promise<void> {
  // ── 1. Connect a mocked wallet ─────────────────────────────────────────────
  //
  // connectDemoWallet() returns a WalletInfo with a deterministic fake signature.
  // In production, use connectMetaMask() or connectMidnightWallet() instead.
  const wallet = await connectDemoWallet('0xAlice_dStorage_Demo');
  console.log('\nWallet connected →', wallet.address, '\n');

  // ── 2. Initialise the SDK with mock adapters ───────────────────────────────
  //
  // MockMidnightChainAdapter simulates the full Midnight transaction flow:
  //   - Internally calls MockProofServer.generateProof() for each write
  //   - Simulates block inclusion delay
  //   - Stores references in memory (localStorage in browser, Map in Node.js)
  //
  // MockStorageAdapter simulates a decentralised storage network:
  //   - Stores encrypted blobs in memory (localStorage in browser, Map in Node.js)
  //   - Generates deterministic content IDs
  const sdk = new DStorage({
    storageAdapter: new MockStorageAdapter(),
    chainAdapter:   new MockMidnightChainAdapter(),
  });

  await sdk.connect(wallet);

  // ── 3. Upload private data ─────────────────────────────────────────────────
  //
  // The SDK automatically:
  //   1. Encrypts the content client-side (AES-GCM 256)
  //   2. Uploads the encrypted blob to the mock storage network
  //   3. Calls the mock proof server via MockMidnightChainAdapter
  //   4. Writes a cryptographic reference on the mock Midnight chain
  const record = JSON.stringify({ patient: 'Alice', plan: 'Gold', active: true });
  const { dataId } = await sdk.upload(record, { label: 'insurance-record' });

  console.log('\nUploaded dataId:', dataId, '\n');

  // ── 4. Retrieve and decrypt ────────────────────────────────────────────────
  //
  // Decryption is fully local — the SDK never sends plaintext anywhere.
  const { content } = await sdk.retrieve(dataId);
  console.log('Retrieved content:', content, '\n');

  // ── 5. Access control ──────────────────────────────────────────────────────
  //
  // grant() writes a permission record on the mock chain (also proof-server-backed).
  // hasAccess() queries the on-chain ACL.
  const bob = '0xBob_Clinic_Verifier';

  const beforeGrant = await sdk.hasAccess(dataId, bob);
  console.log('Bob has access (before grant):', beforeGrant);

  await sdk.grant(dataId, bob);
  const afterGrant = await sdk.hasAccess(dataId, bob);
  console.log('Bob has access (after grant): ', afterGrant);

  await sdk.revoke(dataId, bob);
  const afterRevoke = await sdk.hasAccess(dataId, bob);
  console.log('Bob has access (after revoke):', afterRevoke, '\n');

  // ── 6. Disconnect ──────────────────────────────────────────────────────────
  sdk.disconnect();
  console.log('Done.\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
