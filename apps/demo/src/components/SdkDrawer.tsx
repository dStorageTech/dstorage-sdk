import type { MetaTxProgress, ZkProofProgress } from '@dstorage/core';

interface Props {
  open: boolean;
  mode: 'metatx' | 'zkproof';
  metaTxProgress: MetaTxProgress | null;
  zkProgress: ZkProofProgress | null;
  onToggle: () => void;
}

export function SdkDrawer({ open, mode, metaTxProgress, zkProgress, onToggle }: Props) {
  const hasActivity = !!(metaTxProgress || zkProgress);

  return (
    <div className={`sdk-drawer ${open ? 'open' : ''}`}>
      {/* ── Tab ── */}
      <button className="sdk-drawer-tab" onClick={onToggle}>
        <div className="sdk-tab-left">
          <div className={`sdk-tab-dot ${hasActivity ? 'active' : ''}`} />
          <span className="sdk-tab-title">dStorage SDK</span>
          {hasActivity && (
            <span className="sdk-tab-badge">
              {mode === 'metatx' ? 'Meta-Transaction' : 'ZK Proof Pipeline'}
            </span>
          )}
        </div>
        <div className="sdk-tab-right">
          <span className="sdk-tab-version">v0.1.0</span>
          <span className="sdk-drawer-chevron">{open ? '▼' : '▲'}</span>
        </div>
      </button>

      {/* ── Content ── */}
      <div className="sdk-drawer-body">
        {mode === 'metatx' && metaTxProgress && (
          <MetaTxView progress={metaTxProgress} />
        )}
        {mode === 'zkproof' && zkProgress && (
          <ZkProofView progress={zkProgress} />
        )}
        {!hasActivity && (
          <div className="sdk-empty">
            <span className="sdk-empty-icon">⛓</span>
            <span>SDK activity will appear here when transactions run</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Meta-transaction view ─────────────────────────────────────────────────────

function MetaTxView({ progress }: { progress: MetaTxProgress }) {
  const icons: Record<string, string> = {
    estimate: '⊙', encrypt: '🔒', payment_storage: '💳',
    upload: '↑', payment_chain: '💳', chain_reference: '⛓', complete: '✓',
  };

  return (
    <div className="sdk-view">
      <div className="sdk-view-header">
        <span className="sdk-view-label">Meta-Transaction Pipeline</span>
        <span className={`sdk-view-status status-${progress.overallStatus}`}>
          {progress.overallStatus === 'running' ? '⟳ Running' :
           progress.overallStatus === 'complete' ? '✓ Complete' :
           progress.overallStatus === 'error' ? '✗ Error' : ''}
        </span>
      </div>

      {progress.estimate && (
        <div className="sdk-cost-row">
          <span className="sdk-cost-item">
            Storage: <strong>{progress.estimate.storageCost.amount} {progress.estimate.storageCost.token}</strong>
          </span>
          <span className="sdk-cost-sep">·</span>
          <span className="sdk-cost-item">
            Chain: <strong>{progress.estimate.chainCost.amount} {progress.estimate.chainCost.token}</strong>
          </span>
          <span className="sdk-cost-sep">·</span>
          <span className="sdk-cost-total">Total ≈ ${progress.estimate.totalUsd}</span>
          <span className="sdk-sim-badge">simulated</span>
        </div>
      )}

      <div className="sdk-steps">
        {progress.steps.map((step, i) => (
          <div key={step.id} className={`sdk-step sdk-step-${step.status}`}>
            <div className={`sdk-step-circle sdk-circle-${step.status}`}>
              {step.status === 'running' ? <span className="sdk-spin">⟳</span> :
               step.status === 'done'    ? '✓' :
               step.status === 'error'   ? '✗' : i + 1}
            </div>
            {i < progress.steps.length - 1 && (
              <div className={`sdk-step-conn sdk-conn-${step.status}`} />
            )}
            <div className="sdk-step-content">
              <div className="sdk-step-name">
                <span className="sdk-step-icon">{icons[step.id]}</span>
                <span className={`sdk-step-label sdk-label-${step.status}`}>{step.label}</span>
                {step.durationMs !== undefined && (
                  <span className="sdk-step-ms">{step.durationMs}ms</span>
                )}
              </div>
              {step.detail && (
                <div className={`sdk-step-detail sdk-detail-${step.status}`}>{step.detail}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {progress.receipt && (
        <div className="sdk-receipt">
          <span className="sdk-receipt-label">DataId</span>
          <span className="sdk-receipt-id" onClick={() => navigator.clipboard.writeText(progress.receipt!.dataId)}>
            {progress.receipt.dataId.slice(0, 44)}… <span className="sdk-copy">copy</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ── ZK proof view ─────────────────────────────────────────────────────────────

const ZK_PHASE_STEPS = [
  { id: 'reading',    label: 'Read encrypted record',      icon: '📖' },
  { id: 'witness',    label: 'Generate witness',           icon: '🔍' },
  { id: 'proving',    label: 'Run ZK proving circuit',     icon: '⚡' },
  { id: 'committing', label: 'Commit proof on-chain',      icon: '⛓' },
  { id: 'done',       label: 'Proof generated',            icon: '✓'  },
];

function ZkProofView({ progress }: { progress: ZkProofProgress }) {
  const currentIdx = ZK_PHASE_STEPS.findIndex(s => s.id === progress.phase);

  return (
    <div className="sdk-view">
      <div className="sdk-view-header">
        <span className="sdk-view-label">ZK Proof Pipeline</span>
        <span className="sdk-view-chip">Midnight Compact</span>
      </div>

      <div className="sdk-zk-note">
        <span>🛡</span>
        <span>Private inputs: <code>insurance_record.json</code> — never leaves client</span>
      </div>

      <div className="sdk-steps">
        {ZK_PHASE_STEPS.map((s, i) => {
          const status = i < currentIdx ? 'done' :
                         i === currentIdx ? 'running' : 'pending';
          return (
            <div key={s.id} className={`sdk-step sdk-step-${status}`}>
              <div className={`sdk-step-circle sdk-circle-${status}`}>
                {status === 'running' ? <span className="sdk-spin">⟳</span> :
                 status === 'done'    ? '✓' : i + 1}
              </div>
              {i < ZK_PHASE_STEPS.length - 1 && (
                <div className={`sdk-step-conn sdk-conn-${status}`} />
              )}
              <div className="sdk-step-content">
                <div className="sdk-step-name">
                  <span className="sdk-step-icon">{s.icon}</span>
                  <span className={`sdk-step-label sdk-label-${status}`}>{s.label}</span>
                </div>
                {status === 'running' && progress.detail && (
                  <div className="sdk-step-detail sdk-detail-running">{progress.detail}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {progress.phase === 'done' && (
        <div className="sdk-zk-complete">
          <div className="sdk-zk-row"><span>Circuit</span><code>proveInsuranceEligibility()</code></div>
          <div className="sdk-zk-row"><span>Public inputs</span><code>claim_id, source_ref, chain</code></div>
          <div className="sdk-zk-row"><span>Private inputs</span><code>████████ hidden ████████</code></div>
          <div className="sdk-zk-row"><span>Output</span><code>commitment + nullifier</code></div>
        </div>
      )}
    </div>
  );
}
