import type { AppStep } from "../types";

export function StepIndicator({ step }: { step: AppStep }) {
  const steps = [
    { id: "connect", label: "Choose Adapters" },
    { id: "ready", label: "Choose Workflow" },
    { id: "upload", label: "Upload Certificate" },
    { id: "uploaded", label: "Upload Summary" },
    { id: "prove", label: "Generate Proof" },
    { id: "done", label: "Verified" },
  ] as const;
  const idx = steps.findIndex((s) => s.id === step);
  return (
    <div className="hv-stepper">
      {steps.map((s, i) => {
        const words = s.label.split(" ");
        const splitAt = Math.ceil(words.length / 2);
        const line1 = words.slice(0, splitAt).join(" ");
        const line2 = words.slice(splitAt).join(" ");
        return (
          <div key={s.id} className="hv-step">
            <div
              className={`hv-step-dot ${i < idx ? "past" : i === idx ? "active" : "future"}`}
            >
              {i < idx ? "✓" : i + 1}
            </div>
            <div className="hv-step-text">
              <span className={`hv-step-lbl ${i === idx ? "active" : ""}`}>
                {line1}
              </span>
              <span className={`hv-step-lbl ${i === idx ? "active" : ""}`}>
                {line2 || "\u00A0"}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`hv-step-line ${i < idx ? "past" : ""}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
