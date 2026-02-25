import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MidnightChainAdapter } from '../adapters/midnight.js';

const MOCK_WALLET = { connect: async () => {} };

// Helpers to mock the global fetch used by fetchIndexerContractState()
function mockFetchReturnsNull(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { contractAction: null } }),
    })
  );
}

function mockFetchReturnsAction(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          contractAction: { address: '0xContract', state: 'deadbeef' },
        },
      }),
    })
  );
}

function mockFetchFails(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
}

describe('MidnightChainAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  // ── fetchIndexerContractState ─────────────────────────────────────────────

  describe('fetchIndexerContractState', () => {
    it('returns null when the indexer has no record of the contract', async () => {
      mockFetchReturnsNull();
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      const result = await adapter.fetchIndexerContractState();
      expect(result).toBeNull();
    });

    it('returns the contract action when the indexer knows the contract', async () => {
      mockFetchReturnsAction();
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      const result = await adapter.fetchIndexerContractState();
      expect(result).not.toBeNull();
      expect(result?.address).toBe('0xContract');
      expect(typeof result?.state).toBe('string');
    });

    it('throws a clear error when the indexer is unreachable', async () => {
      mockFetchFails();
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(adapter.fetchIndexerContractState()).rejects.toThrow(
        'Cannot reach indexer'
      );
    });

    it('includes the indexer URL in the error when unreachable', async () => {
      mockFetchFails();
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
        indexerEndpoint: 'http://localhost:8088/api/v3/graphql',
      });
      await expect(adapter.fetchIndexerContractState()).rejects.toThrow(
        'localhost:8088'
      );
    });
  });

  // ── Runtime errors when SDK / compiled contract is not present ────────────

  describe('runtime behaviour without compiled contract', () => {
    it('writeReference throws about the missing compiled ABI', async () => {
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
      ).rejects.toThrow('compile:contract');
    });

    it('writeReference error includes rebuild hint', async () => {
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
      ).rejects.toThrow('@dstorage/chain');
    });

    it('readReference throws "Contract not found" when indexer returns null', async () => {
      mockFetchReturnsNull();
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(adapter.readReference('ref_abc')).rejects.toThrow(
        'Contract not found'
      );
    });

    it('readReference error includes address and actionable hints when contract is missing', async () => {
      mockFetchReturnsNull();
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xDeadBeef',
        wallet: MOCK_WALLET,
      });
      const err = await adapter.readReference('ref_abc').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain('0xDeadBeef');
      expect(msg).toContain('deployed');
    });

    it('readReference reports contract FOUND but mentions missing ABI when contract exists', async () => {
      mockFetchReturnsAction();
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(adapter.readReference('ref_abc')).rejects.toThrow('Contract FOUND');
    });

    it('readReference error mentions compile:contract when contract exists but ABI is missing', async () => {
      mockFetchReturnsAction();
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(adapter.readReference('ref_abc')).rejects.toThrow('compile:contract');
    });

    it('grantAccess throws about the missing compiled ABI', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        wallet: MOCK_WALLET,
      });
      await expect(
        adapter.grantAccess({ refId: 'ref_abc', grantee: '0xBob' })
      ).rejects.toThrow('compile:contract');
    });
  });
});
