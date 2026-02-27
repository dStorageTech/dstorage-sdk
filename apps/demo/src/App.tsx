import { useState, useCallback } from 'react';
import {
  DStorage,
  MockStorageAdapter, ArweaveStorageAdapter, ArweaveLocalStorageAdapter, AutonomiStorageAdapter,
  MockMidnightChainAdapter,
  connectMetaMask, connectDemoWallet,
  INSURANCE_CLAIMS,
  simulateZkProof,
  MockPaymentAdapter,
} from '@dstorage/core';
import { MidnightChainAdapter } from '@dstorage/chain';
import { ArweaveLocalHelper } from '@dstorage/storage';
import type { WalletInfo, MetaTxProgress, ZkProofResult, ZkProofProgress } from '@dstorage/core';
import { PatientPanel } from './components/PatientPanel.tsx';
import { VerifierPanel } from './components/VerifierPanel.tsx';
import { SdkDrawer } from './components/SdkDrawer.tsx';

export type AppStep = 'connect' | 'upload' | 'prove' | 'done';
export interface StoredRecord { dataId: string; fileName: string; uploadedAt: number; chainRefId: string; }

export type StorageAdapterKey = 'mock' | 'arweave-local' | 'arweave' | 'autonomi';
export type ChainAdapterKey = 'mock' | 'midnight-connector';

export const ADAPTER_CONFIGS: Record<StorageAdapterKey, {
  label: string;
  description: string;
  status: 'live' | 'preview' | 'stub';
  note?: string;
}> = {
  mock: {
    label: 'Mock',
    description: 'In-memory store, no network. Instant — ideal for development.',
    status: 'live',
  },
  'arweave-local': {
    label: 'Arweave Local',
    description: 'Local arlocal node — real Arweave flow, no AR tokens needed.',
    status: 'live',
    note: 'docker run -d --rm -p 1984:1984 textury/arlocal  (or: npx arlocal)',
  },
  arweave: {
    label: 'Arweave',
    description: 'Pay-once permanent storage on the permaweb.',
    status: 'preview',
    note: 'Requires the ArConnect browser extension',
  },
  autonomi: {
    label: 'Autonomi',
    description: 'Self-encrypting decentralised network. Memory-backed in this preview.',
    status: 'stub',
  },
};

export const CHAIN_ADAPTER_CONFIGS: Record<ChainAdapterKey, {
  label: string;
  description: string;
  status: 'live' | 'preview' | 'stub';
  note?: string;
}> = {
  mock: {
    label: 'Mock Midnight',
    description: 'Simulated Midnight chain. Instant transactions — ideal for development.',
    status: 'live',
  },
  'midnight-connector': {
    label: 'Midnight Connector (Browser)',
    description: 'Real Midnight network via browser wallet extension.',
    status: 'preview',
    note: 'Requires Midnight Lace wallet extension',
  },
};

export default function App() {
  const [wallet, setWallet]       = useState<WalletInfo | null>(null);
  const [dstorage, setDStorage]   = useState<DStorage | null>(null);
  const [step, setStep]           = useState<AppStep>('connect');
  const [record, setRecord]       = useState<StoredRecord | null>(null);
  const [proof, setProof]         = useState<ZkProofResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified]   = useState<boolean | null>(null);
  const [drawerOpen, setDrawerOpen]         = useState(false);
  const [metaTxProgress, setMetaTxProgress] = useState<MetaTxProgress | null>(null);
  const [zkProgress, setZkProgress]         = useState<ZkProofProgress | null>(null);
  const [drawerMode, setDrawerMode]         = useState<'metatx' | 'zkproof'>('metatx');
  const [storageAdapterKey, setStorageAdapterKey] = useState<StorageAdapterKey>('mock');
  const [chainAdapterKey, setChainAdapterKey] = useState<ChainAdapterKey>('mock');
  const [chainAdapter, setChainAdapter]     = useState<any>(null);

  const buildSDK = useCallback((storageKey: StorageAdapterKey, chainKey: ChainAdapterKey) => {
    const storageAdapter =
      storageKey === 'arweave-local' ? new ArweaveLocalStorageAdapter() :
      storageKey === 'arweave'       ? new ArweaveStorageAdapter() :
      storageKey === 'autonomi'      ? new AutonomiStorageAdapter() :
      new MockStorageAdapter();

    const chainAdapter =
      chainKey === 'midnight-connector'
        ? new MidnightChainAdapter({
            contractAddress: 'midnight:3edc4rfv5tgb6yhn7ujm8ik', // Example contract address
            compiledContract: {}, // In real app, import the compiled contract
            network: 'preprod',
            walletMode: 'connector',
            connectorName: 'mnLace',
          })
        : new MockMidnightChainAdapter();

    // For Midnight, fees are handled internally by the wallet during transaction execution,
    // so we don't need a separate chain payment adapter. For other chains, use mock.
    const dstorageConfig: any = {
      storageAdapter,
      chainAdapter,
    };

    // Only add chainPaymentAdapter for non-Midnight chains
    if (chainKey !== 'midnight-connector') {
      dstorageConfig.chainPaymentAdapter = new MockPaymentAdapter({ token: 'DUST' });
    }

    return {
      sdk: new DStorage(dstorageConfig),
      storageAdapter,
      chainAdapter,
      chainKey
    };
  }, []);

  /**
   * Smart connect: uses the selected adapters without forcing a specific wallet.
   * For Arweave adapters, requests ArConnect to get the real wallet address for minting.
   */
  const handleConnect = async () => {
    try {
      const { sdk, storageAdapter, chainAdapter: newChainAdapter } = buildSDK(storageAdapterKey, chainAdapterKey);

      // Initialize the chain adapter if it's a real Midnight connector
      if (chainAdapterKey === 'midnight-connector') {
        console.log('[Demo] Initializing Midnight Chain Adapter (connector mode)...');
        await newChainAdapter.init();
        console.log('[Demo] ✅ Midnight connector initialized');
      }

      // For Arweave Local, get ArConnect address first to fund the right wallet
      let arweaveAddress: string | null = null;
      if (storageAdapterKey === 'arweave-local' || storageAdapterKey === 'arweave') {
        try {
          // Request ArConnect connection to get the wallet address
          const wallet = typeof window !== 'undefined' ? (window as any).arweaveWallet : null;
          if (wallet) {
            await wallet.connect(['SIGN_TRANSACTION']);
            arweaveAddress = await wallet.getActiveAddress();
            console.log(`[Demo] ArConnect connected: ${arweaveAddress}`);
          } else if (storageAdapterKey === 'arweave-local') {
            // For local testing without ArConnect, use a common test address
            console.warn('[Demo] ArConnect not available — using fallback test address for minting');
            arweaveAddress = 'rJ9qkRpkWlAiLKY_J_5KfIjFfv0O6hYXFrE9wN6qHCE';
          }
        } catch (connectErr) {
          console.warn('[Demo] ArConnect connection failed (will try without it):', connectErr);
          arweaveAddress = 'rJ9qkRpkWlAiLKY_J_5KfIjFfv0O6hYXFrE9wN6qHCE';
        }
      }

      // Auto-mint for local Arweave testing
      if (storageAdapterKey === 'arweave-local' && arweaveAddress) {
        try {
          console.log(`[Demo] Auto-minting test AR tokens to ${arweaveAddress}...`);
          const helper = new ArweaveLocalHelper();
          await helper.mintTokens(arweaveAddress, 10_000_000_000_000n); // 10 AR
          console.log(`[Demo] ✅ Minted 10 AR to ${arweaveAddress.slice(0, 8)}…`);
        } catch (mintErr) {
          console.warn(
            '[Demo] ⚠️ Auto-mint failed (arlocal may not be running):\n' +
            (mintErr instanceof Error ? mintErr.message : String(mintErr))
          );
        }
      }

      // Use demo wallet for encryption key derivation
      const wallet = await connectDemoWallet();

      await sdk.connect(wallet);
      setWallet(wallet);
      setDStorage(sdk);
      setChainAdapter(newChainAdapter);
      setStep('upload');
    } catch (err) {
      console.error('Connection failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Connection failed:\n${msg}`);
    }
  };

  const handleUpload = async (file: File) => {
    if (!dstorage) return;
    setDrawerMode('metatx'); setMetaTxProgress(null); setDrawerOpen(true);
    const receipt = await dstorage.executeMetaTransaction(file,
      (p) => setMetaTxProgress({ ...p }),
      {
        contractAddress: 'midnight:3edc4rfv5tgb6yhn7ujm8ik',
        contractName: 'Midnight Identity Registry',
        circuitId: 'storeReference', circuitName: 'Store Reference',
        metadata: { 'record-type': 'insurance', 'app': 'healthvault' },
      }
    );
    setRecord({ dataId: receipt.dataId, fileName: receipt.file.name, uploadedAt: receipt.completedAt, chainRefId: receipt.chainRefId });
    setStep('prove');
  };

  const handleGenerateProof = async (claimId: string) => {
    if (!record) return;
    const claim = INSURANCE_CLAIMS.find(c => c.id === claimId);
    if (!claim) return;
    setDrawerMode('zkproof'); setZkProgress(null); setDrawerOpen(true);
    const result = await simulateZkProof(claim, record.chainRefId, 'midnight', (p) => setZkProgress({ ...p }));
    setProof(result); setStep('done');
    setVerifying(true);
    await new Promise(r => setTimeout(r, 1800));
    setVerified(result.proofValid); setVerifying(false);
  };

  const handleReset = async () => {
    try {
      // Stop the chain adapter if it's a Midnight connector
      if (chainAdapterKey === 'midnight-connector' && chainAdapter) {
        await chainAdapter.stop();
      }
    } catch (err) {
      console.warn('[Demo] Error stopping chain adapter:', err);
    }

    dstorage?.disconnect();
    setWallet(null); setDStorage(null); setChainAdapter(null); setStep('connect');
    setRecord(null); setProof(null); setVerified(null);
    setDrawerOpen(false); setMetaTxProgress(null); setZkProgress(null);
  };

  return (
    <div className="hv-root">
      <header className="hv-header">
        <div className="hv-logo">
          <div className="hv-logo-mark">✦</div>
          <div>
            <div className="hv-logo-name">HealthVault</div>
            <div className="hv-logo-sub">Private Medical Records on Web3</div>
          </div>
        </div>
        <StepIndicator step={step} />
        <div className="hv-header-right">
          <div className="hv-sdk-badge">Powered by <strong>dStorage SDK</strong></div>
          {wallet && <button className="hv-reset-btn" onClick={() => handleReset()}>New Session</button>}
        </div>
      </header>

      <main className={`hv-main ${drawerOpen ? 'drawer-open' : ''}`}>
        <div className="hv-panel hv-patient">
          <div className="hv-panel-label"><span>👤</span> Patient</div>
          <PatientPanel step={step} wallet={wallet} record={record}
            storageAdapterKey={storageAdapterKey}
            chainAdapterKey={chainAdapterKey}
            onStorageAdapterChange={setStorageAdapterKey}
            onChainAdapterChange={setChainAdapterKey}
            onConnect={handleConnect} onUpload={handleUpload} onGenerateProof={handleGenerateProof} />
        </div>
        <div className="hv-divider">
          <div className="hv-div-line" /><div className="hv-div-icon">⇄</div><div className="hv-div-line" />
        </div>
        <div className="hv-panel hv-verifier">
          <div className="hv-panel-label"><span>🏥</span> Clinic / Verifier</div>
          <VerifierPanel step={step} proof={proof} verifying={verifying} verified={verified} />
        </div>
      </main>

      <SdkDrawer open={drawerOpen} mode={drawerMode} metaTxProgress={metaTxProgress}
        zkProgress={zkProgress} storageAdapterKey={storageAdapterKey}
        onToggle={() => setDrawerOpen(o => !o)} />
    </div>
  );
}

function StepIndicator({ step }: { step: AppStep }) {
  const steps = [
    { id: 'connect', label: 'Connect Wallet' },
    { id: 'upload',  label: 'Upload Record'  },
    { id: 'prove',   label: 'Generate Proof' },
    { id: 'done',    label: 'Verified'        },
  ] as const;
  const idx = steps.findIndex(s => s.id === step);
  return (
    <div className="hv-stepper">
      {steps.map((s, i) => (
        <div key={s.id} className="hv-step">
          <div className={`hv-step-dot ${i < idx ? 'past' : i === idx ? 'active' : 'future'}`}>
            {i < idx ? '✓' : i + 1}
          </div>
          <span className={`hv-step-lbl ${i === idx ? 'active' : ''}`}>{s.label}</span>
          {i < steps.length - 1 && <div className={`hv-step-line ${i < idx ? 'past' : ''}`} />}
        </div>
      ))}
    </div>
  );
}
