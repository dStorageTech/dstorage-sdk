import { useState, useCallback } from 'react';
import {
  DStorage, MockStorageAdapter, MockChainAdapter,
  connectMetaMask, connectDemoWallet,
  INSURANCE_CLAIMS,
  simulateZkProof,
} from '@dstorage/core';
import type { WalletInfo, MetaTxProgress, ZkProofResult, ZkProofProgress } from '@dstorage/core';
import { PatientPanel } from './components/PatientPanel.tsx';
import { VerifierPanel } from './components/VerifierPanel.tsx';
import { SdkDrawer } from './components/SdkDrawer.tsx';

export type AppStep = 'connect' | 'upload' | 'prove' | 'done';
export interface StoredRecord { dataId: string; fileName: string; uploadedAt: number; chainRefId: string; }

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

  const buildSDK = useCallback(() => new DStorage({
    storageAdapter: new MockStorageAdapter(),
    chainAdapter: new MockChainAdapter(),
  }), []);

  const handleConnect = async (mode: 'metamask' | 'demo') => {
    const w = mode === 'metamask' ? await connectMetaMask() : await connectDemoWallet();
    const sdk = buildSDK();
    await sdk.connect(w);
    setWallet(w); setDStorage(sdk); setStep('upload');
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

  const handleReset = () => {
    dstorage?.disconnect();
    setWallet(null); setDStorage(null); setStep('connect');
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
          {wallet && <button className="hv-reset-btn" onClick={handleReset}>New Session</button>}
        </div>
      </header>

      <main className={`hv-main ${drawerOpen ? 'drawer-open' : ''}`}>
        <div className="hv-panel hv-patient">
          <div className="hv-panel-label"><span>👤</span> Patient</div>
          <PatientPanel step={step} wallet={wallet} record={record}
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
        zkProgress={zkProgress} onToggle={() => setDrawerOpen(o => !o)} />
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
