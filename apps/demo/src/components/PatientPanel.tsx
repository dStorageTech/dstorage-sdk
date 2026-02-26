import { useState } from 'react';
import { validateFile, INSURANCE_CLAIMS } from '@dstorage/core';
import type { WalletInfo } from '@dstorage/core';
import type { AppStep, StoredRecord, StorageAdapterKey } from '../App.tsx';
import { ADAPTER_CONFIGS } from '../App.tsx';

interface Props {
  step: AppStep;
  wallet: WalletInfo | null;
  record: StoredRecord | null;
  storageAdapterKey: StorageAdapterKey;
  onStorageAdapterChange: (key: StorageAdapterKey) => void;
  onConnect: (mode: 'metamask' | 'demo') => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  onGenerateProof: (claimId: string) => Promise<void>;
}

export function PatientPanel({ step, wallet, record, storageAdapterKey, onStorageAdapterChange, onConnect, onUpload, onGenerateProof }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedClaim, setSelectedClaim] = useState(INSURANCE_CLAIMS[0]!.id);

  const activeAdapter = ADAPTER_CONFIGS[storageAdapterKey];

  const handleConnect = async (mode: 'metamask' | 'demo') => {
    setLoading('connect');
    try { await onConnect(mode); } finally { setLoading(null); }
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
          Connect your wallet to encrypt and store your insurance records on decentralised storage.
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

      <div className="pp-connect-btns">
        <button className="pp-btn pp-btn-primary" onClick={() => handleConnect('metamask')} disabled={!!loading}>
          {loading === 'connect' ? <Spinner /> : '🦊'} Connect MetaMask
        </button>
        <button className="pp-btn pp-btn-ghost" onClick={() => handleConnect('demo')} disabled={!!loading}>
          🧪 Demo Mode <span className="pp-btn-hint">No wallet needed</span>
        </button>
      </div>
      <div className="pp-privacy-note">
        <span className="pp-privacy-icon">🛡</span>
        Your encryption key is derived from your wallet signature and never leaves your device.
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
            <div className="pp-drop-text">{dragOver ? 'Drop to upload' : 'Drop insurance card or click to browse'}</div>
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
        {loading === 'upload' ? <><Spinner /> Encrypting & Storing…</> : '🔒 Encrypt & Store Record'}
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
