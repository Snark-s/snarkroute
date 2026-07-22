type JobStageIndicatorProps = {
  stage: string;
  status?: string | null;
  message?: string;
};

const activeStages = new Set([
  "preparing_input",
  "exporting_current_frame",
  "validating_input",
  "uploading_asset",
  "creating_job",
  "provider_queued",
  "provider_running",
  "downloading_result",
  "downloading_results",
  "results_downloaded",
  "importing_result",
  "importing_images",
  "importing_video",
  "replacing_layer_source",
  "replacing_placeholder",
  "organizing_project_items",
  "writing_manifest",
  "writing_ae_metadata"
]);

export function JobStageIndicator({ stage, status, message }: JobStageIndicatorProps) {
  const state = terminalState(stage) ?? (activeStages.has(stage) ? null : terminalState(status));
  const classes = ["job-stage"];
  if (state !== null) classes.push(`job-stage-${state}`);
  else if (stage === "provider_queued") classes.push("job-stage-active", "job-stage-warning");
  else classes.push(activeStages.has(stage) ? "job-stage-active" : "job-stage-idle");
  if (stage === "provider_running" && state === null) classes.push("job-stage-running");

  return <div className={classes.join(" ")} role="status" aria-live="polite">
    <span className="job-stage-dot" aria-hidden="true">●</span>
    <span className="job-stage-text">Stage: {stage}{message ? ` · ${message}` : ""}</span>
  </div>;
}

function terminalState(value?: string | null): "success" | "warning" | "error" | "idle" | null {
  if (value === "completed") return "success";
  if (value === "completed_with_warning") return "warning";
  if (value === "failed") return "error";
  if (value === "cancelled" || value === "idle") return "idle";
  return null;
}
