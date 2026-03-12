import type { PendingCertificate } from "../types";

interface CertificatePreviewModalProps {
  certificate: PendingCertificate | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CertificatePreviewModal({
  certificate,
  onConfirm,
  onCancel,
}: CertificatePreviewModalProps) {
  if (!certificate) return null;

  return (
    <div className="hv-contract-modal-backdrop">
      <div className="hv-contract-modal hv-cert-modal">
        <div className="hv-contract-modal-head">
          <h2 className="hv-contract-modal-title">Confirm Certificate</h2>
        </div>
        <p className="hv-contract-modal-body">
          The SDK fetched this document from{" "}
          <strong>{certificate.chainLabel}</strong> using refId{" "}
          <code>{certificate.refId}</code> and decrypted it locally. Confirm
          this is the certificate to use for the ZK proof step.
        </p>

        <div className="hv-cert-meta">
          <div>
            <span>refId</span>
            <code>{certificate.refId}</code>
          </div>
          <div>
            <span>storageId</span>
            <code>{certificate.storageId}</code>
          </div>
          <div>
            <span>size</span>
            <code>{certificate.bytesLength} bytes</code>
          </div>
        </div>

        <div className="hv-cert-preview">
          <div className="hv-cert-preview-title">
            {certificate.previewKind === "pdf"
              ? "Decrypted PDF certificate"
              : certificate.previewKind === "text"
                ? "Decrypted certificate preview"
                : "Binary certificate"}
          </div>
          {certificate.previewKind === "pdf" && certificate.pdfUrl ? (
            <iframe
              className="hv-cert-preview-frame"
              src={certificate.pdfUrl}
              title="Certificate PDF preview"
            />
          ) : (
            <pre>{certificate.preview}</pre>
          )}
          {certificate.truncated && (
            <div className="hv-cert-preview-note">
              Preview truncated for display.
            </div>
          )}
        </div>

        <div className="hv-contract-actions">
          <button
            className="pp-btn pp-btn-primary pp-btn-full"
            type="button"
            onClick={onConfirm}
          >
            Use this certificate
          </button>
          <button
            className="pp-btn pp-btn-ghost pp-btn-full"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
