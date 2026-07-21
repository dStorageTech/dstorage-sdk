import type { ZkProofProgress } from "../zkProof.js";
import type {
  ChainAdapterKey,
  PaymentAdapterKey,
  StorageAdapterKey,
  UploadProgress,
} from "../types";
import {
  ADAPTER_CONFIGS,
  CHAIN_ADAPTER_CONFIGS,
  PAYMENT_ADAPTER_CONFIGS,
} from "../adapterConfigs";

interface Props {
  open: boolean;
  mode: "upload" | "zkproof";
  uploadProgress: UploadProgress | null;
  zkProgress: ZkProofProgress | null;
  storageAdapterKey: StorageAdapterKey;
  chainAdapterKey: ChainAdapterKey;
  paymentAdapterKey: PaymentAdapterKey;
  onToggle: () => void;
}

export function SdkDrawer({
  open,
  mode,
  uploadProgress,
  zkProgress,
  storageAdapterKey,
  chainAdapterKey,
  paymentAdapterKey,
  onToggle,
}: Props) {
  const storageAdapter = ADAPTER_CONFIGS[storageAdapterKey];
  const chainAdapter = CHAIN_ADAPTER_CONFIGS[chainAdapterKey];
  const paymentAdapter = PAYMENT_ADAPTER_CONFIGS[paymentAdapterKey];
  const hasActivity = !!(uploadProgress || zkProgress);

  return (
    <div className={`sdk-drawer ${open ? "open" : ""}`}>
      {/* ── Tab ── */}
      <button className="sdk-drawer-tab" onClick={onToggle}>
        <div className="sdk-tab-left">
          <div className={`sdk-tab-dot ${hasActivity ? "active" : ""}`} />
          <span className="sdk-tab-title">dStorage SDK</span>
          {hasActivity && (
            <span className="sdk-tab-badge">
              {mode === "upload" ? "Upload" : "ZK Proof Pipeline"}
            </span>
          )}
        </div>
        <div className="sdk-tab-center">
          <span className="as-badge as-badge-live">{storageAdapter.label}</span>
          <span className="sdk-tab-config-sep">·</span>
          <span className="as-badge as-badge-live">{chainAdapter.label}</span>
          <span className="sdk-tab-config-sep">·</span>
          <span className={`as-badge as-badge-${paymentAdapter.status}`}>
            {paymentAdapter.label}
          </span>
        </div>
        <div className="sdk-tab-right">
          <span className="sdk-tab-version">v0.1.0</span>
          <span className="sdk-drawer-chevron">{open ? "▼" : "▲"}</span>
        </div>
      </button>

      {/* ── Content ── */}
      <div className="sdk-drawer-body">
        {mode === "upload" && uploadProgress && (
          <UploadView progress={uploadProgress} />
        )}
        {mode === "zkproof" && zkProgress && (
          <ZkProofView progress={zkProgress} />
        )}
        {!hasActivity && (
          <div className="sdk-idle">
            <div className="sdk-idle-config">
              <div className="sdk-idle-title">Active configuration</div>
              <div className="sdk-idle-row">
                <span className="sdk-idle-label">Storage</span>
                <span className="as-badge as-badge-live">
                  {storageAdapter.label}
                </span>
                <span className="sdk-idle-desc">
                  {storageAdapter.description}
                </span>
              </div>
              <div className="sdk-idle-row">
                <span className="sdk-idle-label">Chain</span>
                <span className="as-badge as-badge-live">
                  {chainAdapter.label}
                </span>
                <span className="sdk-idle-desc">
                  {chainAdapter.description}
                </span>
              </div>
              <div className="sdk-idle-row">
                <span className="sdk-idle-label">Payment</span>
                <span className={`as-badge as-badge-${paymentAdapter.status}`}>
                  {paymentAdapter.label}
                </span>
                <span className="sdk-idle-desc">
                  {paymentAdapter.description}
                </span>
              </div>
            </div>
            <div className="sdk-idle-hint">
              <span className="sdk-idle-hint-icon">⛓</span>
              <span>
                SDK transaction activity will appear here when you upload or
                prove
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Upload view ────────────────────────────────────────────────────────────────

const UPLOAD_STEP_ICONS: Record<string, string> = {
  estimate: "⊙",
  store: "🔒",
  chain_reference: "⛓",
  complete: "✓",
};

const UPLOAD_STEP_LABELS: Record<string, string> = {
  estimate: "Estimate Costs",
  store: "Encrypt & Upload to Storage",
  chain_reference: "Write On-Chain Reference",
  complete: "Complete",
};

function UploadView({ progress }: { progress: UploadProgress }) {
  const chainCost =
    progress.result?.costEstimate.chainCost ?? progress.estimate?.chainCost;
  const storageCost =
    progress.result?.costEstimate.storageCost ?? progress.estimate?.storageCost;

  return (
    <div className="sdk-view">
      <div className="sdk-view-header">
        <span className="sdk-view-label">Upload Pipeline</span>
        <span className={`sdk-view-status status-${progress.overallStatus}`}>
          {progress.overallStatus === "running"
            ? "⟳ Running"
            : progress.overallStatus === "complete"
              ? "✓ Complete"
              : progress.overallStatus === "error"
                ? "✗ Error"
                : ""}
        </span>
      </div>

      {(storageCost || chainCost) && (
        <div className="sdk-cost-row">
          <span className="sdk-cost-item">
            Storage:{" "}
            <strong>
              {storageCost ? `${storageCost.amount} ${storageCost.token}` : "—"}
            </strong>
          </span>
          <span className="sdk-cost-sep">·</span>
          <span className="sdk-cost-item">
            Chain:{" "}
            <strong>
              {chainCost ? `${chainCost.amount} ${chainCost.token}` : "—"}
            </strong>
          </span>
          {progress.result ? null : (
            <span className="sdk-sim-badge">estimate</span>
          )}
        </div>
      )}

      <div className="sdk-steps">
        {progress.steps.map((step, i) => (
          <div key={step.id} className={`sdk-step sdk-step-${step.status}`}>
            <div className={`sdk-step-circle sdk-circle-${step.status}`}>
              {step.status === "running" ? (
                <span className="sdk-spin">⟳</span>
              ) : step.status === "done" ? (
                "✓"
              ) : step.status === "error" ? (
                "✗"
              ) : (
                i + 1
              )}
            </div>
            {i < progress.steps.length - 1 && (
              <div className={`sdk-step-conn sdk-conn-${step.status}`} />
            )}
            <div className="sdk-step-content">
              <div className="sdk-step-name">
                <span className="sdk-step-icon">
                  {UPLOAD_STEP_ICONS[step.id]}
                </span>
                <span className={`sdk-step-label sdk-label-${step.status}`}>
                  {UPLOAD_STEP_LABELS[step.id]}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {progress.dataId && (
        <div className="sdk-receipt">
          <span className="sdk-receipt-label">DataId</span>
          <span
            className="sdk-receipt-id"
            onClick={() => navigator.clipboard.writeText(progress.dataId!)}
          >
            {progress.dataId} <span className="sdk-copy">copy</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ── ZK proof view ─────────────────────────────────────────────────────────────

const ZK_PHASE_STEPS = [
  { id: "reading", label: "Read encrypted record", icon: "📖" },
  { id: "witness", label: "Generate witness", icon: "🔍" },
  { id: "proving", label: "Run ZK proving circuit", icon: "⚡" },
  { id: "committing", label: "Commit proof on-chain", icon: "⛓" },
  { id: "done", label: "Proof generated", icon: "✓" },
];

function ZkProofView({ progress }: { progress: ZkProofProgress }) {
  const currentIdx = ZK_PHASE_STEPS.findIndex((s) => s.id === progress.phase);

  return (
    <div className="sdk-view">
      <div className="sdk-view-header">
        <span className="sdk-view-label">ZK Proof Pipeline</span>
        <span className="as-badge as-badge-preview">Simulation</span>
        <span className="sdk-view-chip">Midnight Compact</span>
      </div>

      <div className="sdk-zk-note">
        <span>🛡</span>
        <span>
          Private inputs: <code>insurance_record.json</code> — never leaves
          client
        </span>
      </div>

      <div className="sdk-steps">
        {ZK_PHASE_STEPS.map((s, i) => {
          const status =
            i < currentIdx ? "done" : i === currentIdx ? "running" : "pending";
          return (
            <div key={s.id} className={`sdk-step sdk-step-${status}`}>
              <div className={`sdk-step-circle sdk-circle-${status}`}>
                {status === "running" ? (
                  <span className="sdk-spin">⟳</span>
                ) : status === "done" ? (
                  "✓"
                ) : (
                  i + 1
                )}
              </div>
              {i < ZK_PHASE_STEPS.length - 1 && (
                <div className={`sdk-step-conn sdk-conn-${status}`} />
              )}
              <div className="sdk-step-content">
                <div className="sdk-step-name">
                  <span className="sdk-step-icon">{s.icon}</span>
                  <span className={`sdk-step-label sdk-label-${status}`}>
                    {s.label}
                  </span>
                </div>
                {status === "running" && progress.detail && (
                  <div className="sdk-step-detail sdk-detail-running">
                    {progress.detail}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {progress.phase === "done" && (
        <div className="sdk-zk-complete">
          <div className="sdk-zk-row">
            <span>Circuit</span>
            <code>proveInsuranceEligibility()</code>
          </div>
          <div className="sdk-zk-row">
            <span>Public inputs</span>
            <code>claim_id, source_ref, chain</code>
          </div>
          <div className="sdk-zk-row">
            <span>Private inputs</span>
            <code>████████ hidden ████████</code>
          </div>
          <div className="sdk-zk-row">
            <span>Output</span>
            <code>commitment + nullifier</code>
          </div>
        </div>
      )}
    </div>
  );
}
