import type { PersistedJob } from "../types";
export type JobPhase = "idle" | "preparing input" | "uploading" | "queued" | "running" | "downloading" | "importing" | "completed" | "failed";
export type JobState = { phase: JobPhase; message?: string; jobId?: string };
export type JobAction = { type: "phase"; phase: JobPhase; message?: string; jobId?: string } | { type: "reset" };
export function jobReducer(_state: JobState, action: JobAction): JobState { return action.type === "reset" ? { phase: "idle" } : { phase: action.phase, message: action.message, jobId: action.jobId }; }
const key = "snarkroute.after-effects.active-job.v1";
export function savePendingJob(job: PersistedJob): void { localStorage.setItem(key, JSON.stringify(job)); }
export function restorePendingJob(): PersistedJob | null { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as PersistedJob : null; } catch { return null; } }
export function clearPendingJob(): void { localStorage.removeItem(key); }
