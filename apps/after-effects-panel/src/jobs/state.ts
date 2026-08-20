import type { PersistedJob } from "../types";
export type JobPhase = "idle" | "exporting_current_frame" | "validating_input" | "uploading_asset" | "creating_job" | "provider_queued" | "provider_running" | "downloading_results" | "results_downloaded" | "importing_images" | "importing_video" | "replacing_placeholder" | "organizing_project_items" | "writing_manifest" | "writing_ae_metadata" | "completed" | "completed_with_warning" | "failed" | "cancelled";
export type JobState = { phase: JobPhase; message?: string; jobId?: string };
export type JobAction = { type: "phase"; phase: JobPhase; message?: string; jobId?: string } | { type: "reset" };
export function jobReducer(_state: JobState, action: JobAction): JobState { return action.type === "reset" ? { phase: "idle" } : { phase: action.phase, message: action.message, jobId: action.jobId }; }
const key = "snarkroute.after-effects.active-job.v1";
export function savePendingJob(job: PersistedJob): void { localStorage.setItem(key, JSON.stringify(job)); }
export function restorePendingJob(): PersistedJob | null { try { const value = localStorage.getItem(key); return value ? migratePersistedJob(JSON.parse(value) as PersistedJob) : null; } catch { return null; } }
export function clearPendingJob(): void { localStorage.removeItem(key); }
export function migratePersistedJob(job: PersistedJob): PersistedJob { const outputMediaType = job.outputMediaType ?? "video"; const outputs = job.outputs?.length ? job.outputs : job.outputPath ? [{ kind: outputMediaType, role: "primary", index: 0, path: job.outputPath, filename: job.outputPath.split(/[\\/]/).pop() || "result", mimeType: outputMediaType === "image" ? "image/png" : "video/mp4" }] : []; return { ...job, outputMediaType, operation: job.operation ?? "image-to-video", outputs, primaryOutputIndex: job.primaryOutputIndex ?? 0 }; }
