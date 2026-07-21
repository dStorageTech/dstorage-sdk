import type { UploadProgress, UploadStepId, UploadStepState } from "./types.js";

export function buildInitialUploadSteps(): UploadStepState[] {
  return [
    { id: "estimate", status: "running" },
    { id: "store", status: "pending" },
    { id: "chain_reference", status: "pending" },
    { id: "complete", status: "pending" },
  ];
}

/** Marks `id` done and, if there's a next step, flips it to running. */
export function updateStep(
  progress: UploadProgress,
  id: UploadStepId,
  patch: Partial<Omit<UploadProgress, "steps">> = {},
): UploadProgress {
  const idx = progress.steps.findIndex((s) => s.id === id);
  const steps = progress.steps.map((step, i) => {
    if (i === idx) return { ...step, status: "done" as const };
    if (i === idx + 1) return { ...step, status: "running" as const };
    return step;
  });
  return { ...progress, steps, ...patch };
}

/** store() resolved — mark every remaining step done and the pipeline complete. */
export function completeUpload(progress: UploadProgress): UploadProgress {
  return {
    ...progress,
    steps: progress.steps.map((step) => ({ ...step, status: "done" as const })),
    overallStatus: "complete",
  };
}

export function markUploadError(progress: UploadProgress): UploadProgress {
  const runningIdx = progress.steps.findIndex((s) => s.status === "running");
  const steps =
    runningIdx === -1
      ? progress.steps
      : progress.steps.map((step, i) =>
          i === runningIdx ? { ...step, status: "error" as const } : step,
        );
  return { ...progress, steps, overallStatus: "error" };
}
