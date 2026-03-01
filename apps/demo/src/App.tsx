import { useState, useCallback, useEffect } from 'react';
import {
  DStorage,
  MockStorageAdapter, ArweaveStorageAdapter, ArweaveLocalStorageAdapter, AutonomiStorageAdapter,
  MockMidnightChainAdapter,
  connectDemoWallet,
  INSURANCE_CLAIMS,
  simulateZkProof,
  MockPaymentAdapter,
} from '@dstorage/core';
// MidnightChainAdapter is loaded lazily (Node.js-only deps — not bundled for browser).
import type { WalletInfo, MetaTxProgress, ZkProofResult, ZkProofProgress } from '@dstorage/core';
import { PatientPanel } from './components/PatientPanel.tsx';
import { VerifierPanel } from './components/VerifierPanel.tsx';
import { SdkDrawer } from './components/SdkDrawer.tsx';

export type AppStep = 'connect' | 'upload' | 'prove' | 'done';
export interface StoredRecord { dataId: string; fileName: string; uploadedAt: number; chainRefId: string; }
type ThemeMode = 'light' | 'dark';

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
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = window.localStorage.getItem('demo-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
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
  const [contractAddress, setContractAddress] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('demo-theme', theme);
    }
  }, [theme]);

  const buildSDK = useCallback(async (storageKey: StorageAdapterKey, chainKey: ChainAdapterKey, addr: string) => {
    let storageAdapter;
    if (storageKey === 'arweave-local') {
      // Auto-generate a test JWK wallet and mint AR tokens via arlocal — no ArConnect needed.
      const { adapter } = await ArweaveLocalStorageAdapter.createWithTestWallet();
      storageAdapter = adapter;
    } else {
      storageAdapter =
        storageKey === 'arweave'   ? new ArweaveStorageAdapter() :
        storageKey === 'autonomi'  ? new AutonomiStorageAdapter() :
        new MockStorageAdapter();
    }

    let chainAdapter;
    if (chainKey === 'midnight-connector') {
      // MidnightChainAdapter has Node.js-only dependencies (testkit-js, wallet-sdk-facade, etc.)
      // and cannot be bundled for the browser. It must be loaded lazily at runtime.
      // For now the connector path throws a clear error; real Midnight support
      // requires a separate browser-compatible wallet integration.
      throw new Error(
        'Midnight Connector mode is not yet available in the browser demo.\n' +
        'Select "Mock Midnight" to use the simulated chain adapter.'
      );
    } else {
      chainAdapter = new MockMidnightChainAdapter();
    }

    const chainPaymentAdapter = new MockPaymentAdapter({ token: 'DUST' });

    const dstorageConfig: any = {
      storageAdapter,
      chainAdapter,
      chainPaymentAdapter,
    };

    return { sdk: new DStorage(dstorageConfig) };
  }, []);

  /**
   * Smart connect: uses the selected adapters without forcing a specific wallet.
   * For Arweave adapters, requests ArConnect to get the real wallet address for minting.
   */
  const handleConnect = async () => {
    try {
      const { sdk } = await buildSDK(storageAdapterKey, chainAdapterKey, contractAddress);

      // Use demo wallet for encryption key derivation
      const wallet = await connectDemoWallet();

      await sdk.connect(wallet);
      setWallet(wallet);
      setDStorage(sdk);
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
        contractAddress: contractAddress || 'midnight:mock-contract',
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
    dstorage?.disconnect();
    setWallet(null); setDStorage(null); setStep('connect');
    setRecord(null); setProof(null); setVerified(null);
    setDrawerOpen(false); setMetaTxProgress(null); setZkProgress(null);
  };

  return (
    <div className="hv-root" data-theme={theme}>
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
          <button
            className="hv-theme-toggle"
            type="button"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            aria-pressed={theme === 'dark'}
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          >
            <span className="hv-theme-track">
              <span className={`hv-theme-thumb ${theme === 'dark' ? 'is-dark' : ''}`} />
            </span>
            <span className="hv-theme-label">{theme === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
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
            contractAddress={contractAddress}
            onStorageAdapterChange={setStorageAdapterKey}
            onChainAdapterChange={setChainAdapterKey}
            onContractAddressChange={setContractAddress}
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
