import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COMPUTER_MODE_LABELS, type ComputerMode } from "./types";

const execFileAsync = promisify(execFile);
export const OWNER_TIMEZONE = "Europe/Moscow";

/** One weekly window in Europe/Moscow. `days` are ISO weekdays (1 = Monday) of the window's start; to < from spans midnight. */
export type ScheduleRule = { id: string; days: number[]; from: string; to: string; mode: ComputerMode; label?: string };

export type ModeLimits = {
  heavy: boolean;
  maxHeavy: number;
  maxLight: number;
  reserveVramMiB: number;
  reserveRamMiB: number;
  reserveCpuPercent: number;
};

export type ManualMode = { mode: ComputerMode; setAt: string; by: string; until?: string | null };

export type ComputerModeState = {
  manual?: ManualMode;
  schedule: ScheduleRule[];
  limits: Record<ComputerMode, ModeLimits>;
  /** Process names (lower case, without .exe) of the owner's own heavy applications. */
  ownerApps: string[];
};

export type EffectiveMode = {
  mode: ComputerMode;
  label: string;
  source: "manual" | "schedule" | "default";
  ruleId?: string;
  until?: string;
  reason: string;
  limits: ModeLimits;
  timezone: string;
  localTime: string;
};

export const DEFAULT_MODE_LIMITS: Record<ComputerMode, ModeLimits> = {
  owner_busy: { heavy: false, maxHeavy: 0, maxLight: 1, reserveVramMiB: 1_000_000, reserveRamMiB: 12_288, reserveCpuPercent: 60 },
  background: { heavy: true, maxHeavy: 1, maxLight: 2, reserveVramMiB: 4096, reserveRamMiB: 8192, reserveCpuPercent: 40 },
  free: { heavy: true, maxHeavy: 1, maxLight: 3, reserveVramMiB: 1024, reserveRamMiB: 4096, reserveCpuPercent: 15 }
};

export const DEFAULT_OWNER_APPS = [
  "blender", "unrealeditor", "ue4editor", "touchdesigner", "afterfx", "aerender", "adobe premiere pro", "photoshop",
  "resolve", "houdini", "houdinifx", "cinema 4d", "maya", "3dsmax", "substance painter", "obs64", "mixar"
];

export function defaultComputerModeState(): ComputerModeState {
  return { schedule: [], limits: structuredClone(DEFAULT_MODE_LIMITS), ownerApps: [...DEFAULT_OWNER_APPS] };
}

/** Weekday (1..7) and minute of day in the owner's time zone. */
export function ownerClock(date: Date, timeZone = OWNER_TIMEZONE): { day: number; minutes: number; text: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { day, minutes, text: `${parts.weekday} ${parts.hour}:${parts.minute}` };
}

export function parseClock(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

export function validateScheduleRule(rule: ScheduleRule): string | undefined {
  if (!rule.id?.trim()) return "rule id is required";
  if (!Array.isArray(rule.days) || !rule.days.length || rule.days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) return "days must be ISO weekdays 1..7";
  const from = parseClock(rule.from), to = parseClock(rule.to);
  if (from === undefined || to === undefined) return "from/to must be HH:MM";
  if (from === to) return "from and to must differ";
  if (!(rule.mode in COMPUTER_MODE_LABELS)) return "unknown mode";
  return undefined;
}

export function ruleMatches(rule: ScheduleRule, clock: { day: number; minutes: number }): boolean {
  const from = parseClock(rule.from)!, to = parseClock(rule.to)!;
  if (from < to) return rule.days.includes(clock.day) && clock.minutes >= from && clock.minutes < to;
  const previousDay = clock.day === 1 ? 7 : clock.day - 1;
  return rule.days.includes(clock.day) && clock.minutes >= from || rule.days.includes(previousDay) && clock.minutes < to;
}

const strictness: Record<ComputerMode, number> = { owner_busy: 2, background: 1, free: 0 };

/** Manual choice beats the schedule; overlapping rules resolve to the more protective mode; no rule means background. */
export function effectiveComputerMode(state: ComputerModeState, now = new Date()): EffectiveMode {
  const clock = ownerClock(now);
  const base = { timezone: OWNER_TIMEZONE, localTime: clock.text };
  const manual = state.manual;
  if (manual && (!manual.until || Date.parse(manual.until) > now.getTime())) {
    return { ...base, mode: manual.mode, label: COMPUTER_MODE_LABELS[manual.mode], source: "manual", until: manual.until ?? undefined,
      reason: `Ручной режим${manual.until ? ` до ${formatOwnerTime(manual.until)}` : " до следующего переключения"}`, limits: state.limits[manual.mode] };
  }
  const matches = state.schedule.filter(rule => !validateScheduleRule(rule) && ruleMatches(rule, clock))
    .sort((a, b) => strictness[b.mode] - strictness[a.mode]);
  const rule = matches[0];
  if (rule) {
    return { ...base, mode: rule.mode, label: COMPUTER_MODE_LABELS[rule.mode], source: "schedule", ruleId: rule.id,
      reason: `Расписание: ${rule.label ?? `${rule.from}–${rule.to}`}`, limits: state.limits[rule.mode] };
  }
  return { ...base, mode: "background", label: COMPUTER_MODE_LABELS.background, source: "default",
    reason: state.schedule.length ? "Сейчас нет окна в расписании: консервативный фоновый режим" : "Расписание не задано: консервативный фоновый режим",
    limits: state.limits.background };
}

export function formatOwnerTime(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: OWNER_TIMEZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

let ownerAppCache: { at: number; running: string[] } | undefined;

/** Which of the owner's heavy applications are running. Input idleness is deliberately not used: a render runs without a mouse. */
export async function runningOwnerApps(names: string[], maxAgeMs = 15_000): Promise<string[]> {
  if (ownerAppCache && Date.now() - ownerAppCache.at < maxAgeMs) return ownerAppCache.running.filter(name => names.includes(name));
  let running: string[] = [];
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
      const images = new Set(stdout.split(/\r?\n/).map(line => /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase().replace(/\.exe$/, "")).filter((name): name is string => Boolean(name)));
      running = names.filter(name => images.has(name));
    } catch { running = []; }
  }
  ownerAppCache = { at: Date.now(), running };
  return running;
}
