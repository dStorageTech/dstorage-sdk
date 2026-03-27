import type { ZkProofResult } from "../zkProof.js";
import type { AppStep } from "../types";

interface Props {
  step: AppStep;
  proof: ZkProofResult | null;
  verifying: boolean;
  verified: boolean | null;
}

export function VerifierPanel({ step, proof, verifying, verified }: Props) {
  // ── Waiting state ──────────────────────────────────────────────────────────
  if (step === "connect" || step === "upload" || step === "uploaded")
    return (
      <div className="vp-waiting">
        <div className="vp-waiting-icon">🏥</div>
        <div className="vp-waiting-title">Riverside General Clinic</div>
        <div className="vp-waiting-body">
          Waiting for patient proof request…
        </div>
        <div className="vp-waiting-pulse">
          <div className="vp-pulse-dot" />
          <div className="vp-pulse-ring" />
        </div>
        <div className="vp-waiting-note">
          The clinic will receive a ZK proof — not the patient's records. No
          personal data will be shared.
        </div>
      </div>
    );

  // ── Proof incoming / verifying ─────────────────────────────────────────────
  if (step === "prove" || (step === "done" && verifying))
    return (
      <div className="vp-verifying">
        <div className="vp-ver-header">
          <div className="vp-ver-icon spinning">⚡</div>
          <div className="vp-ver-title">
            {step === "prove" ? "Proof incoming…" : "Verifying proof…"}
          </div>
        </div>
        <div className="vp-ver-steps">
          {[
            "Receiving ZK proof commitment",
            "Checking nullifier (prevents reuse)",
            "Verifying proof against on-chain commitment",
            "Validating expiry and chain signature",
          ].map((s, i) => (
            <div
              key={i}
              className={`vp-ver-step ${step === "done" ? "done" : i === 0 ? "active" : ""}`}
            >
              <span className="vp-ver-step-icon">
                {step === "done" ? "✓" : i === 0 ? "⟳" : "○"}
              </span>
              <span>{s}</span>
            </div>
          ))}
        </div>
        <div className="vp-no-data-note">
          <span>🛡</span> No patient records received — proof only
        </div>
      </div>
    );

  // ── Verified ───────────────────────────────────────────────────────────────
  if (step === "done" && verified !== null && proof) {
    const expiresIn = Math.round(
      (proof.publicInputs.expiresAt - Date.now()) / 1000 / 60 / 60,
    );

    return (
      <div className="vp-result">
        <div className={`vp-verdict ${verified ? "pass" : "fail"}`}>
          <div className="vp-verdict-icon">{verified ? "✓" : "✗"}</div>
          <div className="vp-verdict-title">
            {verified ? "Coverage Verified" : "Verification Failed"}
          </div>
          <div className="vp-verdict-subtitle">
            {verified
              ? "Patient is eligible for treatment"
              : "Could not verify insurance eligibility"}
          </div>
        </div>

        <div className="vp-proof-details">
          <div className="vp-detail-title">
            Proof Details{" "}
            <span className="as-badge as-badge-preview">Simulation</span>
          </div>

          <div className="vp-detail-row">
            <span className="vp-detail-label">Claim Proved</span>
            <span className="vp-detail-value vp-claim-badge">
              {proof.claim.label}
            </span>
          </div>
          <div className="vp-detail-row">
            <span className="vp-detail-label">Commitment</span>
            <span className="vp-detail-value vp-mono">
              {proof.commitment.slice(0, 22)}…
            </span>
          </div>
          <div className="vp-detail-row">
            <span className="vp-detail-label">Nullifier</span>
            <span className="vp-detail-value vp-mono">
              {proof.nullifier.slice(0, 22)}…
            </span>
          </div>
          <div className="vp-detail-row">
            <span className="vp-detail-label">On-chain Source</span>
            <span className="vp-detail-value vp-mono">
              {proof.publicInputs.sourceRefId.slice(0, 20)}…
            </span>
          </div>
          <div className="vp-detail-row">
            <span className="vp-detail-label">Chain</span>
            <span className="vp-detail-value">Midnight Network</span>
          </div>
          <div className="vp-detail-row">
            <span className="vp-detail-label">Valid for</span>
            <span className="vp-detail-value">{expiresIn}h</span>
          </div>
          <div className="vp-detail-row">
            <span className="vp-detail-label">Proof status</span>
            <span className="vp-detail-value vp-status-valid">
              ✓ Valid ZK Proof
            </span>
          </div>
        </div>

        <div className="vp-privacy-box">
          <div className="vp-privacy-title">🛡 Privacy Guarantee</div>
          <p>
            This clinic received <strong>zero patient data.</strong> The ZK
            proof mathematically demonstrates insurance eligibility without
            revealing the policy number, provider, coverage amounts, or any
            personal identifiers.
          </p>
        </div>
      </div>
    );
  }

  return null;
}
