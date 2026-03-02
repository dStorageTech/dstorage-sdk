import { useEffect, useState } from 'react';
import { validateFile, INSURANCE_CLAIMS } from '@dstorage/core';
import type { WalletInfo } from '@dstorage/core';
import type { AppStep, StoredRecord, StorageAdapterKey, ChainAdapterKey } from '../App.tsx';
import { ADAPTER_CONFIGS, CHAIN_ADAPTER_CONFIGS } from '../App.tsx';

interface Props {
  step: AppStep;
  wallet: WalletInfo | null;
  record: StoredRecord | null;
  storageAdapterKey: StorageAdapterKey;
  chainAdapterKey: ChainAdapterKey;
  onStorageAdapterChange: (key: StorageAdapterKey) => void;
  onChainAdapterChange: (key: ChainAdapterKey) => void;
  mockRecords: StoredRecord[];
  onStartUploadFlow: () => Promise<void>;
  onUseExistingRecord: (dataId: string) => void;
  onContinueToProof: () => void;
  onUpload: (file: File) => Promise<void>;
  onGenerateProof: (claimId: string) => Promise<void>;
}

export function PatientPanel({ step, wallet, record, storageAdapterKey, chainAdapterKey, onStorageAdapterChange, onChainAdapterChange, mockRecords, onStartUploadFlow, onUseExistingRecord, onContinueToProof, onUpload, onGenerateProof }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedClaim, setSelectedClaim] = useState(INSURANCE_CLAIMS[0]!.id);
  const [selectedMockRecordId, setSelectedMockRecordId] = useState('');

  const activeAdapter = ADAPTER_CONFIGS[storageAdapterKey];
  const activeChainAdapter = CHAIN_ADAPTER_CONFIGS[chainAdapterKey];

  useEffect(() => {
    if (!selectedMockRecordId && mockRecords.length > 0) {
      setSelectedMockRecordId(mockRecords[0]!.dataId);
    }
  }, [mockRecords, selectedMockRecordId]);

  const handleStartUploadFlow = async () => {
    setLoading('start-upload');
    try { await onStartUploadFlow(); } finally { setLoading(null); }
  };

  const handleUseExistingRecord = () => {
    if (!selectedMockRecordId) return;
    onUseExistingRecord(selectedMockRecordId);
  };

  const handleFile = (file: File) => {
    const v = validateFile(file);
    if (!v.valid) { setFileError(v.error ?? 'Invalid file'); return; }
    setFileError(null); setSelectedFile(file);
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setLoading('upload');
    setUploadError(null);
    try {
      await onUpload(selectedFile);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed. Check your storage adapter configuration.');
    } finally {
      setLoading(null);
    }
  };

  const handleProve = async () => {
    setLoading('prove');
    try { await onGenerateProof(selectedClaim); } finally { setLoading(null); }
  };

  // ── Step: Connect ──────────────────────────────────────────────────────────
  if (step === 'connect') return (
    <div className="pp-section">
      <div className="pp-intro">
        <div className="pp-intro-icon">🔐</div>
        <h2 className="pp-intro-title">Your Health Records, Under Your Control</h2>
        <p className="pp-intro-body">
          Choose your workflow to either upload a new insurance certificate or use an existing one.
          Only you decide who can access your data — and you can prove coverage to any clinic
          without ever sharing your personal details.
        </p>
      </div>

      <div className="as-picker">
        <div className="as-picker-label">Storage Backend</div>
        <div className="as-cards">
          {(Object.entries(ADAPTER_CONFIGS) as [StorageAdapterKey, typeof ADAPTER_CONFIGS[StorageAdapterKey]][]).map(([key, cfg]) => (
            <button
              key={key}
              className={`as-card ${storageAdapterKey === key ? 'selected' : ''}`}
              onClick={() => onStorageAdapterChange(key)}
            >
              <div className="as-card-top">
                <span className="as-card-name">{cfg.label}</span>
                <span className={`as-card-status as-status-${cfg.status}`}>
                  {cfg.status === 'live' ? 'Live' : cfg.status === 'preview' ? 'Preview' : 'Soon'}
                </span>
              </div>
              <div className="as-card-desc">{cfg.description}</div>
              {cfg.note && <div className="as-card-note">{cfg.note}</div>}
            </button>
          ))}
        </div>
        <div className="as-picker-hint">
          Swap the storage backend with one line of code — the SDK handles the rest.
        </div>
      </div>

      <div className="as-picker">
        <div className="as-picker-label">Blockchain Backend</div>
        <div className="as-cards">
          {(Object.entries(CHAIN_ADAPTER_CONFIGS) as [ChainAdapterKey, typeof CHAIN_ADAPTER_CONFIGS[ChainAdapterKey]][]).map(([key, cfg]) => (
            <button
              key={key}
              className={`as-card ${chainAdapterKey === key ? 'selected' : ''}`}
              onClick={() => onChainAdapterChange(key)}
            >
              <div className="as-card-top">
                <span className="as-card-name">{cfg.label}</span>
                <span className={`as-card-status as-status-${cfg.status}`}>
                  {cfg.status === 'live' ? 'Live' : cfg.status === 'preview' ? 'Preview' : 'Soon'}
                </span>
              </div>
              <div className="as-card-desc">{cfg.description}</div>
              {cfg.note && <div className="as-card-note">{cfg.note}</div>}
            </button>
          ))}
        </div>
        <div className="as-picker-hint">
          Choose between mock (for development) or real Midnight network via browser wallet connector.
        </div>
      </div>

      <div className="pp-connect-btns">
        <button className="pp-btn pp-btn-primary pp-btn-full" onClick={handleStartUploadFlow}
          disabled={!!loading}>
          {loading === 'start-upload' ? <Spinner /> : ''} Upload a health insurance certificate
        </button>
      </div>

      <div className="pp-connect-btns">
        <select
          className="pp-contract-addr-input"
          value={selectedMockRecordId}
          onChange={(e) => setSelectedMockRecordId(e.target.value)}
        >
          {mockRecords.map((doc) => (
            <option key={doc.dataId} value={doc.dataId}>
              {doc.fileName} ({new Date(doc.uploadedAt).toLocaleDateString()})
            </option>
          ))}
        </select>
        <button className="pp-btn pp-btn-primary pp-btn-full" onClick={handleUseExistingRecord}
          disabled={!!loading || !selectedMockRecordId}>
          Generate a ZK-proof from uploaded certificate
        </button>
      </div>
      <div className="pp-privacy-note">
        <span className="pp-privacy-icon">🛡</span>
        {storageAdapterKey === 'arweave-local'
          ? '⚠️ Auto-minting test AR tokens for local testing…'
          : 'Your encryption key is derived from your wallet signature and never leaves your device.'}
      </div>
    </div>
  );

  // ── Step: Upload ───────────────────────────────────────────────────────────
  if (step === 'upload') return (
    <div className="pp-section">
      <div className="pp-wallet-chip">
        <div className="pp-wallet-dot" />
        <span className="pp-wallet-addr">{wallet?.address.slice(0, 14)}…{wallet?.address.slice(-6)}</span>
        <span className="pp-wallet-label">Connected</span>
      </div>

      <div className="as-active-row">
        <span className="as-active-label">Storage</span>
        <span className={`as-badge as-badge-${activeAdapter.status}`}>{activeAdapter.label}</span>
        <span className="as-active-desc">{activeAdapter.description}</span>
      </div>

      <h3 className="pp-step-title">Upload Your Insurance Card</h3>
      <p className="pp-step-body">
        Your record will be encrypted with your wallet key before leaving your device.
        The clinic will never see this file — only ZK proofs derived from it.
      </p>

      <div
        className={`pp-dropzone ${dragOver ? 'drag' : ''} ${selectedFile ? 'has-file' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        onClick={() => document.getElementById('hv-file-input')?.click()}
      >
        <input id="hv-file-input" type="file" style={{ display: 'none' }}
          accept="image/*,.pdf,.json,.txt"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
        {selectedFile ? (
          <div className="pp-file-selected">
            <div className="pp-file-icon">{selectedFile.type.startsWith('image/') ? '🖼' : '📄'}</div>
            <div>
              <div className="pp-file-name">{selectedFile.name}</div>
              <div className="pp-file-meta">{(selectedFile.size / 1024).toFixed(1)} KB · {selectedFile.type}</div>
            </div>
            <button className="pp-file-clear" onClick={e => { e.stopPropagation(); setSelectedFile(null); }}>✕</button>
          </div>
        ) : (
          <div className="pp-drop-prompt">
            <div className="pp-drop-icon">↑</div>
            <div className="pp-drop-text">{dragOver ? 'Drop to upload' : 'Drop health insurance certificate or click to browse'}</div>
            <div className="pp-drop-hint">PDF, image, JSON · max 10 MB</div>
          </div>
        )}
      </div>
      {fileError   && <div className="pp-error">{fileError}</div>}
      {uploadError && <div className="pp-error">{uploadError}</div>}

      <div className="pp-encrypt-note">
        <div className="pp-encrypt-steps">
          {['AES-GCM 256 encryption', 'Decentralised storage', 'On-chain reference'].map((s, i) => (
            <div key={i} className="pp-encrypt-step">
              <div className="pp-encrypt-num">{i + 1}</div>
              <span>{s}</span>
            </div>
          ))}
        </div>
      </div>

      <button className="pp-btn pp-btn-primary pp-btn-full" onClick={handleUpload}
        disabled={!selectedFile || !!loading}>
        {loading === 'upload' ? <><Spinner /> Encrypting & Storing…</> : '🔒 Encrypt & Store Certificate'}
      </button>
    </div>
  );

  // ── Step: Uploaded summary ────────────────────────────────────────────────
  if (step === 'uploaded') return (
    <div className="pp-section">
      <div className="pp-done">
        <div className="pp-done-icon">✓</div>
        <div className="pp-done-title">Certificate Uploaded</div>
        <div className="pp-done-body">
          Your certificate is encrypted, stored, and referenced on-chain.
        </div>
      </div>

      <div className="pp-privacy-guarantee">
        <div className="pp-pg-row"><span className="pp-pg-icon">📄</span><span>{record?.fileName ?? 'Insurance certificate'}</span></div>
        <div className="pp-pg-row"><span className="pp-pg-icon">🔗</span><span>Reference: {record?.chainRefId.slice(0, 28)}…</span></div>
        <div className="pp-pg-row">
          <span className="pp-pg-icon">📦</span>
          <span>
            Storage adapter: <strong>{activeAdapter.label}</strong>{' '}
            <span className={`as-badge as-badge-${activeAdapter.status}`} style={{ fontSize: '10px' }}>
              {activeAdapter.status === 'live' ? 'Live' : activeAdapter.status === 'preview' ? 'Preview' : 'Soon'}
            </span>
          </span>
        </div>
        <div className="pp-pg-row">
          <span className="pp-pg-icon">⛓</span>
          <span>
            Chain adapter: <strong>{activeChainAdapter.label}</strong>{' '}
            <span className={`as-badge as-badge-${activeChainAdapter.status}`} style={{ fontSize: '10px' }}>
              {activeChainAdapter.status === 'live' ? 'Live' : activeChainAdapter.status === 'preview' ? 'Preview' : 'Soon'}
            </span>
          </span>
        </div>
      </div>

      <button className="pp-btn pp-btn-primary pp-btn-full" onClick={onContinueToProof}>
        ⚡ Continue to Generate Proof
      </button>
    </div>
  );

  // ── Step: Prove ────────────────────────────────────────────────────────────
  if (step === 'prove') return (
    <div className="pp-section">
      <div className="pp-record-stored">
        <div className="pp-record-check">✓</div>
        <div>
          <div className="pp-record-title">Record Stored & Encrypted</div>
          <div className="pp-record-file">{record?.fileName}</div>
          <div className="pp-record-ref">Ref: {record?.chainRefId.slice(0, 28)}…</div>
        </div>
      </div>

      <h3 className="pp-step-title">Generate Insurance Proof</h3>
      <p className="pp-step-body">
        Select a claim to prove to the clinic. A ZK proof will be generated from your
        encrypted record — <strong>no personal data is ever shared.</strong>
      </p>

      <div className="pp-claims">
        {INSURANCE_CLAIMS.map(claim => (
          <button key={claim.id}
            className={`pp-claim-card ${selectedClaim === claim.id ? 'selected' : ''}`}
            onClick={() => setSelectedClaim(claim.id)}>
            <div className="pp-claim-header">
              <div className="pp-claim-name">{claim.label}</div>
              {selectedClaim === claim.id && <div className="pp-claim-check">✓</div>}
            </div>
            <div className="pp-claim-desc">{claim.description}</div>
            <div className="pp-claim-field">
              <span className="pp-claim-field-label">Proves:</span>
              <span className="pp-claim-field-value">{claim.recordField}</span>
              <span className="pp-claim-field-hidden">value hidden</span>
            </div>
          </button>
        ))}
      </div>

      <button className="pp-btn pp-btn-primary pp-btn-full" onClick={handleProve} disabled={!!loading}>
        {loading === 'prove' ? <><Spinner /> Generating ZK Proof…</> : '⚡ Generate & Send Proof'}
      </button>
    </div>
  );

  // ── Step: Done ─────────────────────────────────────────────────────────────
  return (
    <div className="pp-section">
      <div className="pp-done">
        <div className="pp-done-icon">✓</div>
        <div className="pp-done-title">Proof Submitted</div>
        <div className="pp-done-body">Your insurance eligibility has been proven to the clinic without revealing any personal data.</div>
      </div>
      <div className="pp-privacy-guarantee">
        <div className="pp-pg-row"><span className="pp-pg-icon">🔒</span><span>Encryption key never left your device</span></div>
        <div className="pp-pg-row">
          <span className="pp-pg-icon">📦</span>
          <span>
            Encrypted blob stored via <strong>{activeAdapter.label}</strong> adapter
            {' '}<span className={`as-badge as-badge-${activeAdapter.status}`} style={{ fontSize: '10px' }}>{activeAdapter.status === 'live' ? 'Live' : activeAdapter.status === 'preview' ? 'Preview' : 'Soon'}</span>
          </span>
        </div>
        <div className="pp-pg-row"><span className="pp-pg-icon">⚡</span><span>Only a ZK commitment was shared — zero personal data</span></div>
        <div className="pp-pg-row"><span className="pp-pg-icon">⛓</span><span>Proof committed on-chain and verifiable by any party</span></div>
      </div>
    </div>
  );
}

function Spinner() { return <span className="pp-spinner">⟳</span>; }
