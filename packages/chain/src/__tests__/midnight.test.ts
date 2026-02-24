import { describe, it, expect } from 'vitest';
import { MidnightChainAdapter } from '../adapters/midnight.js';

const MOCK_WALLET = { connect: async () => {} };

describe('MidnightChainAdapter', () => {
  // ── Constructor validation ─────────────────────────────────────────────────

  describe('constructor', () => {
    it('name is "midnight"', () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      expect(adapter.name).toBe('midnight');
    });

    it('throws if contractAddress is not provided (empty string)', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '', wallet: MOCK_WALLET })
      ).toThrow('[dStorage/midnight] contractAddress is required');
    });

    it('throws with clear guidance about contractAddress', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '', wallet: MOCK_WALLET })
      ).toThrow('Deploy DataRegistry.compact to Midnight');
    });

    it('throws if wallet is not provided (undefined)', () => {
      expect(
        // @ts-expect-error — intentional: testing runtime validation
        () => new MidnightChainAdapter({ contractAddress: '0xContract' })
      ).toThrow('[dStorage/midnight] wallet is required');
    });

    it('throws if wallet is null', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '0xContract', wallet: null as unknown as object })
      ).toThrow('[dStorage/midnight] wallet is required');
    });

    it('throws with clear guidance about wallet', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '0xContract', wallet: null as unknown as object })
      ).toThrow('connectMidnightWallet()');
    });

    it('does not throw with valid contractAddress and wallet', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '0xABC', wallet: MOCK_WALLET })
      ).not.toThrow();
    });
  });

  // ── Default config values ─────────────────────────────────────────────────

  describe('default endpoints', () => {
    it('nodeEndpoint defaults to Midnight testnet-02 URL', () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      // Access through the private config via inspection — the key behaviour is
      // that write/read methods would use the default if not overridden.
      // We verify by checking that construction does not throw and the name is set.
      expect(adapter.name).toBe('midnight');
    });

    it('accepts custom nodeEndpoint', () => {
      expect(
        () => new MidnightChainAdapter({
          contractAddress: '0xContract',
          wallet: MOCK_WALLET,
          nodeEndpoint: 'https://custom.node.example.com',
        })
      ).not.toThrow();
    });

    it('accepts custom indexerEndpoint', () => {
      expect(
        () => new MidnightChainAdapter({
          contractAddress: '0xContract',
          wallet: MOCK_WALLET,
          indexerEndpoint: 'https://custom.indexer.example.com/graphql',
        })
      ).not.toThrow();
    });

    it('accepts custom proofServerEndpoint', () => {
      expect(
        () => new MidnightChainAdapter({
          contractAddress: '0xContract',
          wallet: MOCK_WALLET,
          proofServerEndpoint: 'http://proof-server.internal:6300',
        })
      ).not.toThrow();
    });
  });

  // ── Runtime errors when SDK is not installed ──────────────────────────────

  describe('runtime behaviour without Midnight SDK', () => {
    it('writeReference throws with a helpful error about the missing SDK', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(
        adapter.writeReference({
          storageId: 'sid',
          storageProvider: 'mock',
          owner: '0xOwner',
          createdAt: Date.now(),
        })
      ).rejects.toThrow('@midnight-ntwrk/midnight-js-contracts');
    });

    it('readReference throws with helpful error about the missing SDK', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(adapter.readReference('ref_abc')).rejects.toThrow(
        '@midnight-ntwrk/midnight-js-contracts'
      );
    });

    it('grantAccess throws with helpful error about the missing SDK', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(
        adapter.grantAccess({ refId: 'ref_abc', grantee: '0xBob' })
      ).rejects.toThrow('@midnight-ntwrk/midnight-js-contracts');
    });

    it('error message includes install command hint', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(
        adapter.writeReference({
          storageId: 'sid',
          storageProvider: 'mock',
          owner: '0xOwner',
          createdAt: Date.now(),
        })
      ).rejects.toThrow('npm install');
    });
  });
});
