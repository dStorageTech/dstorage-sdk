import { describe, it, expect, vi, afterEach } from 'vitest';
import { MidnightChainAdapter } from '../adapters/midnight/midnight.js';

const MOCK_CREDENTIALS = { mnemonic: 'test test test test test test test test test test test junk' };
const MOCK_NETWORK = 'undeployed' as const;

describe('MidnightChainAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Constructor validation ─────────────────────────────────────────────────

  describe('constructor', () => {
    it('name is "midnight"', () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        network: MOCK_NETWORK,
        credentials: MOCK_CREDENTIALS,
      });
      expect(adapter.name).toBe('midnight');
    });

    it('throws if contractAddress is not provided (empty string)', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '', network: MOCK_NETWORK, credentials: MOCK_CREDENTIALS })
      ).toThrow('[dStorage/midnight] contractAddress is required');
    });

    it('throws with clear guidance about contractAddress', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '', network: MOCK_NETWORK, credentials: MOCK_CREDENTIALS })
      ).toThrow('Deploy your DataRegistry contract');
    });

    it('throws if credentials are not provided (undefined)', () => {
      expect(
        // @ts-expect-error — intentional: testing runtime validation
        () => new MidnightChainAdapter({ contractAddress: '0xContract', network: MOCK_NETWORK })
      ).toThrow('[dStorage/midnight] credentials.mnemonic or credentials.seedHex is required');
    });

    it('throws if network is not provided (undefined)', () => {
      expect(
        // @ts-expect-error — intentional: testing runtime validation
        () => new MidnightChainAdapter({ contractAddress: '0xContract', credentials: MOCK_CREDENTIALS })
      ).toThrow('[dStorage/midnight] network is required');
    });

    it('throws if credentials.mnemonic and credentials.seedHex are both missing in facade mode', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '0xContract', network: MOCK_NETWORK, walletMode: 'facade', credentials: {} })
      ).toThrow('credentials.mnemonic or credentials.seedHex is required');
    });

    it('does not throw when credentials are missing in connector mode', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '0xContract', network: MOCK_NETWORK, walletMode: 'connector' })
      ).not.toThrow();
    });

    it('does not throw with valid contractAddress and credentials in facade mode', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '0xABC', network: MOCK_NETWORK, credentials: MOCK_CREDENTIALS })
      ).not.toThrow();
    });

    it('does not throw with valid contractAddress in connector mode', () => {
      expect(
        () => new MidnightChainAdapter({ contractAddress: '0xABC', network: MOCK_NETWORK, walletMode: 'connector' })
      ).not.toThrow();
    });

    it('does not throw when contractAddress is omitted (auto-deploy mode)', () => {
      expect(
        () => new MidnightChainAdapter({ network: MOCK_NETWORK, credentials: MOCK_CREDENTIALS })
      ).not.toThrow();
    });
  });

  // ── Default config values ─────────────────────────────────────────────────

  describe('default endpoints', () => {
    it('accepts custom nodeEndpoint', () => {
      expect(
        () => new MidnightChainAdapter({
          contractAddress: '0xContract',
          network: MOCK_NETWORK,
          credentials: MOCK_CREDENTIALS,
          nodeEndpoint: 'https://custom.node.example.com',
        })
      ).not.toThrow();
    });

    it('accepts custom indexerEndpoint', () => {
      expect(
        () => new MidnightChainAdapter({
          contractAddress: '0xContract',
          network: MOCK_NETWORK,
          credentials: MOCK_CREDENTIALS,
          indexerEndpoint: 'https://custom.indexer.example.com/graphql',
        })
      ).not.toThrow();
    });

    it('accepts custom proofServerEndpoint', () => {
      expect(
        () => new MidnightChainAdapter({
          contractAddress: '0xContract',
          network: MOCK_NETWORK,
          credentials: MOCK_CREDENTIALS,
          proofServerEndpoint: 'http://proof-server.internal:6300',
        })
      ).not.toThrow();
    });
  });

  // ── Runtime behaviour when wallet is not initialized ─────────────────────

  describe('runtime behaviour when wallet is not initialized', () => {
    it('writeReference throws about wallet not initialized (facade mode)', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        network: MOCK_NETWORK,
        credentials: MOCK_CREDENTIALS,
      });
      await expect(
        adapter.writeReference({
          storageId: 'sid',
          storageProvider: 'mock',
          owner: '0xOwner',
          createdAt: Date.now(),
        })
      ).rejects.toThrow('init()');
    });

    it('writeReference throws about wallet not initialized (connector mode)', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        network: MOCK_NETWORK,
        walletMode: 'connector',
        zkConfigBaseUrl: 'http://localhost:3000',
      });
      await expect(
        adapter.writeReference({
          storageId: 'sid',
          storageProvider: 'mock',
          owner: '0xOwner',
          createdAt: Date.now(),
        })
      ).rejects.toThrow('init()');
    });

    it('readReference throws about wallet not initialized (facade mode)', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        network: MOCK_NETWORK,
        credentials: MOCK_CREDENTIALS,
      });
      await expect(adapter.readReference('ref_abc')).rejects.toThrow('init()');
    });

    it('listReferences throws about wallet not initialized (facade mode)', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        network: MOCK_NETWORK,
        credentials: MOCK_CREDENTIALS,
      });
      await expect(adapter.listReferences()).rejects.toThrow('init()');
    });
  });

  // ── setContractAddress ────────────────────────────────────────────────────

  describe('setContractAddress', () => {
    it('accepts a new contract address without throwing', () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xOld',
        network: MOCK_NETWORK,
        credentials: MOCK_CREDENTIALS,
      });
      expect(() => adapter.setContractAddress('0xNew')).not.toThrow();
    });
  });

  // ── deployDataRegistry ────────────────────────────────────────────────────

  describe('deployDataRegistry', () => {
    it('throws when called before init()', async () => {
      const adapter = new MidnightChainAdapter({
        network: MOCK_NETWORK,
        credentials: MOCK_CREDENTIALS,
      });
      await expect(adapter.deployDataRegistry()).rejects.toThrow('before init()');
    });

    it('throws in connector mode', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        network: MOCK_NETWORK,
        walletMode: 'connector',
      });
      await expect(adapter.deployDataRegistry()).rejects.toThrow('connector mode');
    });
  });

  // ── callCircuit / queryCircuit (not supported) ────────────────────────────

  describe('callCircuit and queryCircuit', () => {
    it('callCircuit throws "not supported"', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        network: MOCK_NETWORK,
        credentials: MOCK_CREDENTIALS,
      });
      await expect(adapter.callCircuit('anyCircuit', [])).rejects.toThrow('not supported');
    });

    it('queryCircuit throws "not supported"', async () => {
      const adapter = new MidnightChainAdapter({
        contractAddress: '0xContract',
        network: MOCK_NETWORK,
        credentials: MOCK_CREDENTIALS,
      });
      await expect(adapter.queryCircuit('anyQuery', [])).rejects.toThrow('not supported');
    });
  });
});
