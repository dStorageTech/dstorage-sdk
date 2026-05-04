import { useEffect, useState } from "react";
import { validateFile } from "@dstorage-tech/dstorage";
import { INSURANCE_CLAIMS } from "../zkProof.js";
import type { DataReferenceSummary } from "@dstorage-tech/dstorage";
import type {
  AppStep,
  StoredRecord,
  StorageAdapterKey,
  ChainAdapterKey,
  PaymentAdapterKey,
} from "../types";
import {
  ADAPTER_CONFIGS,
  CHAIN_ADAPTER_CONFIGS,
  PAYMENT_ADAPTER_CONFIGS,
} from "../adapterConfigs";

interface Props {
  step: AppStep;
  connected: boolean;
  record: StoredRecord | null;
  storageAdapterKey: StorageAdapterKey;
  chainAdapterKey: ChainAdapterKey;
  paymentAdapterKey: PaymentAdapterKey;
  managedAuthToken: string;
  managedServiceUrl: string;
  onStorageAdapterChange: (key: StorageAdapterKey) => void;
  onChainAdapterChange: (key: ChainAdapterKey) => void;
  onPaymentAdapterChange: (key: PaymentAdapterKey) => void;
  onManagedAuthTokenChange: (token: string) => void;
  existingReferences: Array<DataReferenceSummary>;
  onContinueFromSetup: () => void;
  onStartUploadFlow: () => Promise<void>;
  onLoadExistingReferences: () => Promise<void>;
  onUseExistingRecord: (refId: string) => Promise<void>;
  onContinueToProof: () => void;
  onUpload: (file: File) => Promise<void>;
  onGenerateProof: (claimId: string) => Promise<void>;
}

export function PatientPanel({
  step,
  connected,
  record,
  storageAdapterKey,
  chainAdapterKey,
  paymentAdapterKey,
  managedAuthToken,
  managedServiceUrl,
  onStorageAdapterChange,
  onChainAdapterChange,
  onPaymentAdapterChange,
  onManagedAuthTokenChange,
  existingReferences,
  onContinueFromSetup,
  onStartUploadFlow,
  onLoadExistingReferences,
  onUseExistingRecord,
  onContinueToProof,
  onUpload,
  onGenerateProof,
}: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedClaim, setSelectedClaim] = useState(INSURANCE_CLAIMS[0]!.id);
  const [selectedRefId, setSelectedRefId] = useState("");
  const [activePath, setActivePath] = useState<"a" | "b">("a");

  const activeAdapter = ADAPTER_CONFIGS[storageAdapterKey];
  const activeChainAdapter = CHAIN_ADAPTER_CONFIGS[chainAdapterKey];
  const managedUserIdRequired =
    paymentAdapterKey === "managed" && !managedAuthToken.trim();

  useEffect(() => {
    if (existingReferences.length === 0 && selectedRefId) {
      setSelectedRefId("");
      return;
    }
    if (!selectedRefId && existingReferences.length > 0) {
      setSelectedRefId(existingReferences[0]!.refId);
    }
  }, [existingReferences, selectedRefId]);

  const handleStartUploadFlow = async () => {
    setLoading("start-upload");
    try {
      await onStartUploadFlow();
    } finally {
      setLoading(null);
    }
  };

  const handleUseExistingRecord = () => {
    if (!selectedRefId) return;
    setLoading("use-existing");
    onUseExistingRecord(selectedRefId).finally(() => setLoading(null));
  };

  const handleLoadExistingReferences = () => {
    setLoading("load-refs");
    onLoadExistingReferences().finally(() => setLoading(null));
  };

  const handleFile = (file: File) => {
    const v = validateFile(file);
    if (!v.valid) {
      setFileError(v.error ?? "Invalid file");
      return;
    }
    setFileError(null);
    setSelectedFile(file);
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setLoading("upload");
    setUploadError(null);
    try {
      await onUpload(selectedFile);
    } catch (err) {
      setUploadError(
        err instanceof Error
          ? err.message
          : "Upload failed. Check your storage adapter configuration.",
      );
    } finally {
      setLoading(null);
    }
  };

  const handleProve = async () => {
    setLoading("prove");
    try {
      await onGenerateProof(selectedClaim);
    } finally {
      setLoading(null);
    }
  };

  const formatRefLabel = (ref: DataReferenceSummary): string => {
    const shortRefId =
      ref.refId.length > 16
        ? `${ref.refId.slice(0, 8)}...${ref.refId.slice(-8)}`
        : ref.refId;
    const isPublic = !ref.encryptionScheme;
    if (isPublic) return `${shortRefId} (public)`;
    return ref.storageId
      ? shortRefId
      : `${shortRefId} (cannot decrypt content id)`;
  };

  const selectedReference = existingReferences.find(
    (r) => r.refId === selectedRefId,
  );
  const selectedRefCannotDecrypt =
    selectedReference && selectedReference.storageId === null;

  // ── Step: Connect (adapter selection — full-width page) ───────────────────
  if (step === "connect")
    return (
      <div className="pp-section">
        <div className="as-picker">
          <div className="as-picker-label">Storage Backend</div>
          <div className="as-cards">
            {(
              Object.entries(ADAPTER_CONFIGS) as [
                StorageAdapterKey,
                (typeof ADAPTER_CONFIGS)[StorageAdapterKey],
              ][]
            ).map(([key, cfg]) => (
              <button
                key={key}
                className={`as-card ${storageAdapterKey === key ? "selected" : ""}`}
                onClick={() => onStorageAdapterChange(key)}
              >
                <div className="as-card-top">
                  <span className="as-card-name">{cfg.label}</span>
                </div>
                <div className="as-card-desc">{cfg.description}</div>
                {cfg.note && <div className="as-card-note">{cfg.note}</div>}
                {cfg.cmd && storageAdapterKey === key && (
                  <div className="as-card-cmd">
                    <span className="as-card-cmd-label">Run locally:</span>
                    <code className="as-card-cmd-code">{cfg.cmd}</code>
                  </div>
                )}
              </button>
            ))}
          </div>
          <div className="as-picker-hint">
            Swap the storage backend with one line of code — the SDK handles the
            rest.
          </div>
        </div>

        <div className="as-picker">
          <div className="as-picker-label">Blockchain Backend</div>
          <div className="as-cards">
            {(
              Object.entries(CHAIN_ADAPTER_CONFIGS) as [
                ChainAdapterKey,
                (typeof CHAIN_ADAPTER_CONFIGS)[ChainAdapterKey],
              ][]
            ).map(([key, cfg]) => (
              <button
                key={key}
                className={`as-card ${chainAdapterKey === key ? "selected" : ""}`}
                onClick={() => onChainAdapterChange(key)}
              >
                <div className="as-card-top">
                  <span className="as-card-name">{cfg.label}</span>
                </div>
                <div className="as-card-desc">{cfg.description}</div>
                {cfg.note && <div className="as-card-note">{cfg.note}</div>}
              </button>
            ))}
          </div>
          <div className="as-picker-hint">
            Choose between mock (for development) or real Midnight network via
            browser wallet connector.
          </div>
        </div>

        <div className="as-picker">
          <div className="as-picker-label">Payment Backend</div>
          <div className="as-cards">
            {(
              Object.entries(PAYMENT_ADAPTER_CONFIGS) as [
                PaymentAdapterKey,
                (typeof PAYMENT_ADAPTER_CONFIGS)[PaymentAdapterKey],
              ][]
            ).map(([key, cfg]) => (
              <button
                key={key}
                className={`as-card ${paymentAdapterKey === key ? "selected" : ""}`}
                onClick={() => onPaymentAdapterChange(key)}
              >
                <div className="as-card-top">
                  <span className="as-card-name">{cfg.label}</span>
                </div>
                <div className="as-card-desc">{cfg.description}</div>
                {cfg.note && <div className="as-card-note">{cfg.note}</div>}
              </button>
            ))}
          </div>
          {paymentAdapterKey === "local" &&
            (storageAdapterKey === "arweave" ||
              chainAdapterKey === "midnight-connector") && (
              <div className="pp-managed-info">
                <div className="pp-managed-info-title">
                  Browser Wallet Extensions Required
                </div>
                <p className="pp-managed-info-body">
                  Local payment uses your browser wallet extension to sign and
                  pay fees directly — no intermediary service involved.
                </p>
                <ul className="pp-managed-info-list">
                  {storageAdapterKey === "arweave" && (
                    <li>
                      <strong>Wander</strong> — required for Arweave storage
                      fees. Install from{" "}
                      <a
                        href="https://www.wander.app/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        wander.app
                      </a>
                    </li>
                  )}
                  {chainAdapterKey === "midnight-connector" && (
                    <li>
                      <strong>Lace</strong> — required for Midnight transaction
                      fees. Install from{" "}
                      <a
                        href="https://www.lace.io/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        lace.io
                      </a>
                      . Need test NIGHT tokens?{" "}
                      <a
                        href="https://faucet.preprod.midnight.network/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Midnight Preprod Faucet
                      </a>
                    </li>
                  )}
                </ul>
              </div>
            )}
          {paymentAdapterKey === "managed" && (
            <div className="pp-payments-fields">
              <div className="pp-managed-info">
                <div className="pp-managed-info-title">
                  dStorage Managed Payment Service
                </div>
                <p className="pp-managed-info-body">
                  The dStorage managed payment service handles both Midnight
                  transaction and Arweave storage fees on your behalf. To use it
                  you need either:
                </p>
                <ul className="pp-managed-info-list">
                  <li>
                    A <strong>dStorage Pro</strong> account — sign up or manage
                    your account at{" "}
                    <a
                      href="https://dstorage.pro"
                      target="_blank"
                      rel="noreferrer"
                    >
                      dstorage.pro
                    </a>
                  </li>
                  <li>
                    A <strong>locally running dStorage Pro service</strong> (for
                    testing purposes only)
                  </li>
                </ul>
              </div>
              <div className="pp-contract-addr">
                <label
                  className="pp-contract-addr-label"
                  htmlFor="managed-auth-token"
                >
                  Auth Token
                </label>
                <input
                  id="managed-auth-token"
                  className="pp-contract-addr-input"
                  value={managedAuthToken}
                  onChange={(e) => onManagedAuthTokenChange(e.target.value)}
                  placeholder="Enter auth token"
                />
              </div>
              <div className="pp-contract-addr">
                <label
                  className="pp-contract-addr-label"
                  htmlFor="managed-service-url"
                >
                  Service URL
                </label>
                <input
                  id="managed-service-url"
                  className="pp-contract-addr-input"
                  value={managedServiceUrl}
                  readOnly
                />
              </div>
              {managedUserIdRequired && (
                <div className="pp-error">
                  Auth token is required for managed payments.
                </div>
              )}
            </div>
          )}
          <div className="as-picker-hint">
            Choose how storage and chain fees are paid — swap with one line of
            code.
          </div>
        </div>

        <button
          className="pp-btn pp-btn-primary pp-btn-full"
          type="button"
          disabled={managedUserIdRequired}
          onClick={onContinueFromSetup}
        >
          Continue →
        </button>
      </div>
    );

  // ── Step: Ready (workflow selection — split screen patient panel) ──────────
  if (step === "ready")
    return (
      <div className="pp-section">
        <div className="pp-intro">
          <div className="pp-intro-icon">🔐</div>
          <h2 className="pp-intro-title">
            Your Health Records, Under Your Control
          </h2>
          <p className="pp-intro-body">
            Choose your workflow to either upload a new insurance certificate or
            use an existing one. Only you decide who can access your data — and
            you can prove coverage to any clinic without ever sharing your
            personal details.
          </p>
        </div>

        <div className="pp-path-tabs">
          <div
            className="pp-path-tab-list"
            role="tablist"
            aria-label="Workflow"
          >
            <button
              className={`pp-path-tab ${activePath === "a" ? "active" : ""}`}
              role="tab"
              aria-selected={activePath === "a"}
              type="button"
              onClick={() => setActivePath("a")}
            >
              Path A · Upload New
            </button>
            <button
              className={`pp-path-tab ${activePath === "b" ? "active" : ""}`}
              role="tab"
              aria-selected={activePath === "b"}
              type="button"
              onClick={() => setActivePath("b")}
            >
              Path B · Use Existing
            </button>
          </div>

          <section className="pp-path-card" role="tabpanel">
            {activePath === "a" ? (
              <>
                <h3 className="pp-path-title">Upload a New Certificate</h3>
                <p className="pp-path-body">
                  Start with a new health insurance certificate. The file is
                  encrypted locally, stored, and then referenced on-chain.
                </p>
                <button
                  className="pp-btn pp-btn-primary pp-btn-full"
                  onClick={handleStartUploadFlow}
                  disabled={!!loading || managedUserIdRequired}
                >
                  {loading === "start-upload" ? <Spinner /> : ""} Start Upload
                  Flow
                </button>
              </>
            ) : (
              <>
                <h3 className="pp-path-title">
                  Generate Proof from Existing Reference
                </h3>
                <p className="pp-path-body">
                  Load references already stored on-chain, select a `refId`,
                  review and confirm the decrypted certificate, then continue to
                  proof generation.
                </p>
                <div className="pp-connect-btns">
                  <button
                    className="pp-btn pp-btn-ghost pp-btn-full"
                    onClick={handleLoadExistingReferences}
                    disabled={!!loading}
                  >
                    {loading === "load-refs" ? <Spinner /> : ""} Load References
                  </button>
                  <select
                    className="pp-contract-addr-input"
                    value={selectedRefId}
                    onChange={(e) => setSelectedRefId(e.target.value)}
                  >
                    {existingReferences.length === 0 ? (
                      <option value=""></option>
                    ) : (
                      existingReferences.map((ref) => (
                        <option key={ref.refId} value={ref.refId}>
                          {formatRefLabel(ref)}
                        </option>
                      ))
                    )}
                  </select>
                  {selectedRefCannotDecrypt && (
                    <div className="pp-ref-warning">
                      Cannot decrypt content id
                    </div>
                  )}
                  <button
                    className="pp-btn pp-btn-primary pp-btn-full"
                    onClick={handleUseExistingRecord}
                    disabled={
                      !!loading || !selectedRefId || selectedRefCannotDecrypt
                    }
                  >
                    Review Certificate
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
        <div className="pp-privacy-note">
          <span className="pp-privacy-icon">🛡</span>
          {storageAdapterKey === "arweave-local"
            ? "⚠️ Auto-minting test AR tokens for local testing…"
            : "Your encryption key is derived from your wallet signature and never leaves your device."}
        </div>
      </div>
    );

  // ── Step: Upload ───────────────────────────────────────────────────────────
  if (step === "upload")
    return (
      <div className="pp-section">
        {connected && (
          <div className="pp-wallet-chip">
            <div className="pp-wallet-dot" />
            <span className="pp-wallet-label">SDK Connected</span>
          </div>
        )}

        <div className="as-active-row">
          <span className="as-active-label">Storage</span>
          <span className="as-badge as-badge-live">{activeAdapter.label}</span>
          <span className="as-active-desc">{activeAdapter.description}</span>
        </div>

        <h3 className="pp-step-title">Upload Your Insurance Card</h3>
        <p className="pp-step-body">
          Your record will be encrypted with your wallet key before leaving your
          device. The clinic will never see this file — only ZK proofs derived
          from it.
        </p>

        <div
          className={`pp-dropzone ${dragOver ? "drag" : ""} ${selectedFile ? "has-file" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
          onClick={() => document.getElementById("hv-file-input")?.click()}
        >
          <input
            id="hv-file-input"
            type="file"
            style={{ display: "none" }}
            accept="image/*,.pdf,.json,.txt"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          {selectedFile ? (
            <div className="pp-file-selected">
              <div className="pp-file-icon">
                {selectedFile.type.startsWith("image/") ? "🖼" : "📄"}
              </div>
              <div>
                <div className="pp-file-name">{selectedFile.name}</div>
                <div className="pp-file-meta">
                  {(selectedFile.size / 1024).toFixed(1)} KB ·{" "}
                  {selectedFile.type}
                </div>
              </div>
              <button
                className="pp-file-clear"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedFile(null);
                }}
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="pp-drop-prompt">
              <div className="pp-drop-icon">↑</div>
              <div className="pp-drop-text">
                {dragOver
                  ? "Drop to upload"
                  : "Drop health insurance certificate or click to browse"}
              </div>
              <div className="pp-drop-hint">PDF, image, JSON · max 10 MB</div>
            </div>
          )}
        </div>
        {fileError && <div className="pp-error">{fileError}</div>}
        {uploadError && <div className="pp-error">{uploadError}</div>}

        <div className="pp-encrypt-note">
          <div className="pp-encrypt-steps">
            {[
              "Client side encryption",
              "Decentralised storage",
              "On-chain reference",
            ].map((s, i) => (
              <div key={i} className="pp-encrypt-step">
                <div className="pp-encrypt-num">{i + 1}</div>
                <span>{s}</span>
              </div>
            ))}
          </div>
        </div>

        <button
          className="pp-btn pp-btn-primary pp-btn-full"
          onClick={handleUpload}
          disabled={!selectedFile || !!loading}
        >
          {loading === "upload" ? (
            <>
              <Spinner /> Encrypting & Storing…
            </>
          ) : (
            "🔒 Encrypt & Store Certificate"
          )}
        </button>
      </div>
    );

  // ── Step: Uploaded summary ────────────────────────────────────────────────
  if (step === "uploaded")
    return (
      <div className="pp-section">
        <div className="pp-done">
          <div className="pp-done-icon">✓</div>
          <div className="pp-done-title">Certificate Uploaded</div>
          <div className="pp-done-body">
            Your certificate is encrypted, stored, and referenced on-chain.
          </div>
        </div>

        <div className="pp-privacy-guarantee">
          <div className="pp-pg-row">
            <span className="pp-pg-icon">📄</span>
            <span>{record?.fileName ?? "Insurance certificate"}</span>
          </div>
          <div className="pp-id-block">
            <div className="pp-id-label">Storage ID</div>
            <div className="pp-id-value">
              {record?.storageId ?? "(unknown)"}
            </div>
          </div>
          <div className="pp-id-block">
            <div className="pp-id-label">Reference ID (refId)</div>
            <div className="pp-id-value">
              {record?.refId ?? record?.chainRefId ?? "(unknown)"}
            </div>
          </div>
          <div className="pp-pg-row">
            <span className="pp-pg-icon">📦</span>
            <span>
              Storage adapter: <strong>{activeAdapter.label}</strong>
            </span>
          </div>
          <div className="pp-pg-row">
            <span className="pp-pg-icon">⛓</span>
            <span>
              Chain adapter: <strong>{activeChainAdapter.label}</strong>
            </span>
          </div>
        </div>

        <button
          className="pp-btn pp-btn-primary pp-btn-full"
          onClick={onContinueToProof}
        >
          ⚡ Continue to Generate Proof
        </button>
      </div>
    );

  // ── Step: Prove ────────────────────────────────────────────────────────────
  if (step === "prove")
    return (
      <div className="pp-section">
        <div className="pp-record-stored">
          <div className="pp-record-check">✓</div>
          <div>
            <div className="pp-record-title">Record Stored & Encrypted</div>
            <div className="pp-record-file">{record?.fileName}</div>
            <div className="pp-record-ref">
              Ref: {record?.chainRefId.slice(0, 28)}…
            </div>
          </div>
        </div>

        <h3 className="pp-step-title">
          Generate Insurance Proof{" "}
          <span className="as-badge as-badge-preview">Simulation</span>
        </h3>
        <p className="pp-step-body">
          Select a claim to prove to the clinic. A ZK proof will be generated
          from your encrypted record —{" "}
          <strong>no personal data is ever shared.</strong>
        </p>

        <div className="pp-claims">
          {INSURANCE_CLAIMS.map((claim) => (
            <button
              key={claim.id}
              className={`pp-claim-card ${selectedClaim === claim.id ? "selected" : ""}`}
              onClick={() => setSelectedClaim(claim.id)}
            >
              <div className="pp-claim-header">
                <div className="pp-claim-name">{claim.label}</div>
                {selectedClaim === claim.id && (
                  <div className="pp-claim-check">✓</div>
                )}
              </div>
              <div className="pp-claim-desc">{claim.description}</div>
              <div className="pp-claim-field">
                <span className="pp-claim-field-label">Proves:</span>
                <span className="pp-claim-field-value">
                  {claim.recordField}
                </span>
                <span className="pp-claim-field-hidden">value hidden</span>
              </div>
            </button>
          ))}
        </div>

        <button
          className="pp-btn pp-btn-primary pp-btn-full"
          onClick={handleProve}
          disabled={!!loading}
        >
          {loading === "prove" ? (
            <>
              <Spinner /> Generating ZK Proof…
            </>
          ) : (
            "⚡ Generate & Send Proof"
          )}
        </button>
      </div>
    );

  // ── Step: Done ─────────────────────────────────────────────────────────────
  return (
    <div className="pp-section">
      <div className="pp-done">
        <div className="pp-done-icon">✓</div>
        <div className="pp-done-title">
          Proof Submitted{" "}
          <span className="as-badge as-badge-preview">Simulation</span>
        </div>
        <div className="pp-done-body">
          Your insurance eligibility has been proven to the clinic without
          revealing any personal data.
        </div>
      </div>
      <div className="pp-privacy-guarantee">
        <div className="pp-pg-row">
          <span className="pp-pg-icon">🔒</span>
          <span>Encryption key never left your device</span>
        </div>
        <div className="pp-pg-row">
          <span className="pp-pg-icon">📦</span>
          <span>
            Encrypted blob stored via <strong>{activeAdapter.label}</strong>{" "}
            adapter
          </span>
        </div>
        <div className="pp-pg-row">
          <span className="pp-pg-icon">⚡</span>
          <span>Only a ZK commitment was shared — zero personal data</span>
        </div>
        <div className="pp-pg-row">
          <span className="pp-pg-icon">⛓</span>
          <span>Proof committed on-chain and verifiable by any party</span>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return <span className="pp-spinner">⟳</span>;
}
