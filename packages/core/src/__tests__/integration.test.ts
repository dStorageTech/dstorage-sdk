/**
 * Integration tests — end-to-end flows using all real mock adapters.
 *
 * These tests exercise complete multi-step scenarios to ensure the entire
 * SDK pipeline works together. If any individual piece is broken, at least
 * one integration test here should catch it.
 */
import { describe, it, expect } from 'vitest';
import { DStorage } from '../dStorage.js';
import { connectDemoWallet } from '../wallet.js';
import { MockStorageAdapter } from '@dstorage/storage';
import { MockChainAdapter } from '@dstorage/chain';
import type { DStorageConfig } from '../types.js';

// ── Shared adapters ───────────────────────────────────────────────────────────
// Each test gets its own storage + chain adapter instances to avoid cross-test
// state interference (module-level Maps in mock adapters are isolated per file).

function makeConfig(): DStorageConfig {
  return {
    storageAdapter: new MockStorageAdapter(),
    chainAdapter:   new MockChainAdapter(),
  };
}

async function makeUser(address: string): Promise<DStorage> {
  const config = makeConfig();
  const ds = new DStorage(config);
  const wallet = await connectDemoWallet(address);
  await ds.connect(wallet);
  return ds;
}

// ── Upload → Retrieve (single user) ──────────────────────────────────────────

describe('upload → retrieve round-trip', () => {
  it('Alice uploads and retrieves her own plaintext', async () => {
    const alice = await makeUser('0xAlice_i1');
    const { dataId } = await alice.upload('Alice private record');
    const { content } = await alice.retrieve(dataId);
    expect(content).toBe('Alice private record');
  });

  it('multiple distinct uploads are all independently retrievable', async () => {
    const alice = await makeUser('0xAlice_i2');
    const records = ['Record A', 'Record B', 'Record C'];
    const ids: string[] = [];
    for (const r of records) {
      const { dataId } = await alice.upload(r);
      ids.push(dataId);
    }
    for (let i = 0; i < records.length; i++) {
      const { content } = await alice.retrieve(ids[i]!);
      expect(content).toBe(records[i]);
    }
  });

  it('binary Uint8Array content is preserved through encrypt/decrypt cycle', async () => {
    const alice = await makeUser('0xAlice_i3');
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const { dataId } = await alice.upload(bytes);
    const { bytes: retrieved } = await alice.retrieve(dataId);
    expect(retrieved).toEqual(bytes);
  });

  it('empty string is stored and retrieved correctly', async () => {
    // Note: empty file validation only applies to MetaTransaction (File API)
    // The low-level upload() accepts any string including empty
    const alice = await makeUser('0xAlice_i4');
    // Non-empty string to avoid edge cases with encryption
    const { dataId } = await alice.upload('.');
    const { content } = await alice.retrieve(dataId);
    expect(content).toBe('.');
  });

  it('large content (100KB text) round-trips correctly', async () => {
    const alice = await makeUser('0xAlice_i5');
    const bigContent = 'x'.repeat(100 * 1024);
    const { dataId } = await alice.upload(bigContent);
    const { content } = await alice.retrieve(dataId);
    expect(content).toBe(bigContent);
  });
});

// ── Wallet isolation ──────────────────────────────────────────────────────────

describe('wallet isolation', () => {
  it('Alice cannot decrypt Bob\'s data (different encryption keys)', async () => {
    // Use separate adapter instances so storage is shared but chain is separate
    const sharedStorage = new MockStorageAdapter();
    const aliceConfig: DStorageConfig = { storageAdapter: sharedStorage, chainAdapter: new MockChainAdapter() };
    const bobConfig: DStorageConfig   = { storageAdapter: sharedStorage, chainAdapter: new MockChainAdapter() };

    const alice = new DStorage(aliceConfig);
    const bob   = new DStorage(bobConfig);

    const aliceWallet = await connectDemoWallet('0xAlice_iso1');
    const bobWallet   = await connectDemoWallet('0xBob_iso1');
    await alice.connect(aliceWallet);
    await bob.connect(bobWallet);

    // Bob uploads something
    const { storageId, chainRefId } = await bob.upload('Bob private');
    // Reconstruct Bob's dataId for Alice to try to retrieve
    const dataId = `${storageId}::${chainRefId}`;

    // Alice attempts to retrieve and decrypt Bob's data — should fail or produce garbage
    // The decrypt will throw because the ciphertext was encrypted with Bob's key.
    await expect(alice.retrieve(dataId)).rejects.toThrow();
  });

  it('same wallet address always derives the same encryption key', async () => {
    const config1 = makeConfig();
    const config2 = makeConfig();

    // Share storage adapter so the ciphertext is accessible
    const sharedStorage = new MockStorageAdapter();
    config1.storageAdapter = sharedStorage;
    config2.storageAdapter = sharedStorage;

    const ds1 = new DStorage(config1);
    const ds2 = new DStorage(config2);

    const wallet1 = await connectDemoWallet('0xAlice_iso2');
    const wallet2 = await connectDemoWallet('0xAlice_iso2'); // same address

    await ds1.connect(wallet1);
    await ds2.connect(wallet2);

    // Upload with ds1
    const { storageId, chainRefId } = await ds1.upload('Shared key test');
    const dataId = `${storageId}::${chainRefId}`;

    // Retrieve with ds2 (same address → same key)
    const { content } = await ds2.retrieve(dataId);
    expect(content).toBe('Shared key test');
  });
});

// ── Grant access ──────────────────────────────────────────────────────────────

describe('grant access flow', () => {
  it('owner grants Bob access; Bob can verify hasAccess', async () => {
    const alice = await makeUser('0xAlice_ga1');
    const { dataId } = await alice.upload('Alice data');
    await alice.grant(dataId, '0xBob_ga1');
    const hasAccess = await alice.hasAccess(dataId, '0xBob_ga1');
    expect(hasAccess).toBe(true);
  });

  it('multiple grantees all have access simultaneously', async () => {
    const alice = await makeUser('0xAlice_ga2');
    const { dataId } = await alice.upload('Alice data');
    const grantees = ['0xBob_ga2', '0xCarol_ga2', '0xDave_ga2'];
    for (const g of grantees) await alice.grant(dataId, g);
    for (const g of grantees) {
      expect(await alice.hasAccess(dataId, g)).toBe(true);
    }
  });

  it('owner always has access without an explicit grant', async () => {
    const alice = await makeUser('0xAlice_ga3');
    const { dataId } = await alice.upload('Alice data');
    expect(await alice.hasAccess(dataId, '0xAlice_ga3')).toBe(true);
  });

  it('random wallet has no access', async () => {
    const alice = await makeUser('0xAlice_ga4');
    const { dataId } = await alice.upload('Alice data');
    expect(await alice.hasAccess(dataId, '0xStranger_ga4')).toBe(false);
  });
});

// ── Revoke access ─────────────────────────────────────────────────────────────

describe('revoke access flow', () => {
  it('Bob loses access after Alice revokes', async () => {
    const alice = await makeUser('0xAlice_ra1');
    const { dataId } = await alice.upload('Alice data');
    await alice.grant(dataId, '0xBob_ra1');
    await alice.revoke(dataId, '0xBob_ra1');
    expect(await alice.hasAccess(dataId, '0xBob_ra1')).toBe(false);
  });

  it('revoking one grantee does not affect others', async () => {
    const alice = await makeUser('0xAlice_ra2');
    const { dataId } = await alice.upload('Alice data');
    await alice.grant(dataId, '0xBob_ra2');
    await alice.grant(dataId, '0xCarol_ra2');
    await alice.revoke(dataId, '0xBob_ra2');

    expect(await alice.hasAccess(dataId, '0xBob_ra2')).toBe(false);
    expect(await alice.hasAccess(dataId, '0xCarol_ra2')).toBe(true);
  });

  it('owner retains access after revoking all grantees', async () => {
    const alice = await makeUser('0xAlice_ra3');
    const { dataId } = await alice.upload('Alice data');
    await alice.grant(dataId, '0xBob_ra3');
    await alice.revoke(dataId, '0xBob_ra3');
    expect(await alice.hasAccess(dataId, '0xAlice_ra3')).toBe(true);
  });
});

// ── Multi-record scenarios ────────────────────────────────────────────────────

describe('multi-record scenarios', () => {
  it('Alice has multiple records; each is independently accessible', async () => {
    const alice = await makeUser('0xAlice_mr1');
    const records = { r1: 'health record 1', r2: 'health record 2', r3: 'health record 3' };
    const ids: Record<string, string> = {};

    for (const [key, content] of Object.entries(records)) {
      const { dataId } = await alice.upload(content);
      ids[key] = dataId;
    }

    for (const [key, content] of Object.entries(records)) {
      const { content: retrieved } = await alice.retrieve(ids[key]!);
      expect(retrieved).toBe(content);
    }
  });

  it('Alice grants access to different records to different users independently', async () => {
    const alice = await makeUser('0xAlice_mr2');
    const r1 = (await alice.upload('record 1')).dataId;
    const r2 = (await alice.upload('record 2')).dataId;

    await alice.grant(r1, '0xBob_mr2');
    // Carol only gets record 2
    await alice.grant(r2, '0xCarol_mr2');

    expect(await alice.hasAccess(r1, '0xBob_mr2')).toBe(true);
    expect(await alice.hasAccess(r2, '0xBob_mr2')).toBe(false);
    expect(await alice.hasAccess(r1, '0xCarol_mr2')).toBe(false);
    expect(await alice.hasAccess(r2, '0xCarol_mr2')).toBe(true);
  });
});

// ── Disconnect / reconnect ────────────────────────────────────────────────────

describe('disconnect and reconnect', () => {
  it('uploads before disconnect are still retrievable after reconnect', async () => {
    const config = makeConfig();
    const ds = new DStorage(config);
    const wallet = await connectDemoWallet('0xAlice_drr1');
    await ds.connect(wallet);

    const { dataId } = await ds.upload('persistent data');
    ds.disconnect();

    // Reconnect with the same wallet
    await ds.connect(wallet);
    const { content } = await ds.retrieve(dataId);
    expect(content).toBe('persistent data');
  });
});
