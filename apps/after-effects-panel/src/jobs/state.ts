import type { PersistedJob } from "../types";
export type JobPhase = "idle" | "exporting_current_frame" | "validating_input" | "uploading_asset" | "creating_job" | "provider_queued" | "provider_running" | "downloading_result" | "video_downloaded" | "importing_result" | "replacing_layer_source" | "writing_manifest" | "writing_ae_metadata" | "completed" | "completed_with_warning" | "failed";
export type JobState = { phase: JobPhase; message?: string; jobId?: string };
export type JobAction = { type: "phase"; phase: JobPhase; message?: string; jobId?: string } | { type: "reset" };
export function jobReducer(_state: JobState, action: JobAction): JobState { return action.type === "reset" ? { phase: "idle" } : { phase: action.phase, message: action.message, jobId: action.jobId }; }
const key = "snarkroute.after-effects.active-job.v1";
export function savePendingJob(job: PersistedJob): void { localStorage.setItem(key, JSON.stringify(job)); }
export function restorePendingJob(): PersistedJob | null { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as PersistedJob : null; } catch { return null; } }
export function clearPendingJob(): void { localStorage.removeItem(key); }
