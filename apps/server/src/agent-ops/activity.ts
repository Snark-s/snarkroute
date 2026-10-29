import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * What the computer is actually doing, per process: GPU engine utilisation and
 * dedicated VRAM (Windows GPU performance counters), CPU share, and known
 * render command lines. An open application is only a signal; load decides.
 */

const execFileAsync = promisify(execFile);

export type ProcessActivity = { pid: number; name: string; gpuPercent: number; vramMiB: number; cpuPercent: number };
export type ActivitySample = {
  at: string;
  ok: boolean;
  error?: string;
  totalCpuPercent?: number;
  processes: ProcessActivity[];
  renders: Array<{ pid: number; name: string; detail: string }>;
};

export type OwnerActivity = {
  /** true: heavy background work should wait. */
  busy: boolean;
  confidence: "measured" | "unknown";
  reasons: string[];
  /** Open owner applications and their state, shown even when they do not block. */
  signals: string[];
  sampledAt?: string;
};

export type ActivityThresholds = { appGpuPercent: number; appCpuPercent: number; externalGpuPercent: number; externalVramMiB: number; totalCpuPercent: number };

export const DEFAULT_ACTIVITY_THRESHOLDS: ActivityThresholds = {
  appGpuPercent: 15, appCpuPercent: 25, externalGpuPercent: 40, externalVramMiB: 3072, totalCpuPercent: 75
};

const RENDER_PATTERNS: Array<{ name: RegExp; command?: RegExp; label: string }> = [
  { name: /^aerender$/i, label: "рендер After Effects (aerender)" },
  { name: /^blender$/i, command: /(\s|^)(-b|--background)(\s|$)/, label: "фоновый рендер Blender" },
  { name: /^unrealeditor-cmd$/i, label: "Unreal Editor в режиме команд (рендер/сборка)" },
  { name: /^(cinema 4d|commandline)$/i, command: /-render/i, label: "рендер Cinema 4D" },
  { name: /^(hython|husk)$/i, label: "рендер Houdini" }
];

/** One PowerShell call; about 1–4 s, so it runs in a background sampler, never on a request path. */
const PROBE_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$gpu=@{}; $mem=@{}
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.UtilizationPercentage -gt 0 } | ForEach-Object { if ($_.Name -match 'pid_(\\d+)') { $gpu[$matches[1]] = [double]$gpu[$matches[1]] + $_.UtilizationPercentage } }
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | ForEach-Object { if ($_.Name -match 'pid_(\\d+)') { $mem[$matches[1]] = [double]$mem[$matches[1]] + $_.DedicatedUsage } }
$cores=[Environment]::ProcessorCount
$cpu=@{}; $names=@{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | ForEach-Object { $cpu["$($_.IDProcess)"]=[double]$_.PercentProcessorTime/$cores; $names["$($_.IDProcess)"]=($_.Name -replace '#\\d+$','') }
$total=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
$ids=@($gpu.Keys)+@($mem.Keys | Where-Object { $mem[$_] -gt 256MB })+@($cpu.Keys | Where-Object { $cpu[$_] -gt 5 }) | Select-Object -Unique
$procs=foreach($id in $ids){ [pscustomobject]@{ pid=[int]$id; name=[string]$names[$id]; gpuPercent=[math]::Round([double]$gpu[$id],1); vramMiB=[math]::Round([double]$mem[$id]/1MB); cpuPercent=[math]::Round([double]$cpu[$id],1) } }
$render=Get-CimInstance Win32_Process -Filter "Name='aerender.exe' OR Name='blender.exe' OR Name='UnrealEditor-Cmd.exe' OR Name='Commandline.exe' OR Name='hython.exe' OR Name='husk.exe'" | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; name=($_.Name -replace '\\.exe$',''); command=[string]$_.CommandLine } }
[pscustomobject]@{ totalCpuPercent=[double]$total; processes=@($procs); renders=@($render) } | ConvertTo-Json -Depth 4 -Compress
`;

export async function sampleActivity(): Promise<ActivitySample> {
  const at = new Date().toISOString();
  if (process.platform !== "win32") return { at, ok: false, error: "счётчики нагрузки есть только на Windows", processes: [], renders: [] };
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROBE_SCRIPT], { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
    const parsed = JSON.parse(stdout.trim() || "{}") as { totalCpuPercent?: number; processes?: ProcessActivity[] | ProcessActivity; renders?: Array<{ pid: number; name: string; command: string }> | { pid: number; name: string; command: string } };
    const list = <T>(value: T[] | T | undefined): T[] => Array.isArray(value) ? value : value ? [value] : [];
    const renders = list(parsed.renders).flatMap(item => {
      const pattern = RENDER_PATTERNS.find(entry => entry.name.test(item.name) && (!entry.command || entry.command.test(item.command ?? "")));
      return pattern ? [{ pid: item.pid, name: item.name, detail: pattern.label }] : [];
    });
    return { at, ok: true, totalCpuPercent: parsed.totalCpuPercent, processes: list(parsed.processes).map(item => ({ ...item, name: String(item.name ?? "").toLowerCase() })), renders };
  } catch (error) {
    return { at, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : String(error), processes: [], renders: [] };
  }
}

/**
 * Decides whether background heavy work should wait. `ownProcessNames` are
 * SnarkRoute's own runtimes (their load is ours, already covered by leases);
 * `heavyLeaseActive` means some GPU load is expected from our own work.
 */
export function assessOwnerActivity(samples: ActivitySample[], options: { ownerApps: string[]; ownProcessNames: string[]; heavyLeaseActive: boolean; thresholds?: ActivityThresholds; maxAgeMs?: number; now?: number }): OwnerActivity {
  const thresholds = options.thresholds ?? DEFAULT_ACTIVITY_THRESHOLDS;
  const now = options.now ?? Date.now();
  const fresh = samples.filter(sample => sample.ok && now - Date.parse(sample.at) <= (options.maxAgeMs ?? 90_000)).slice(-3);
  if (!fresh.length) {
    const last = samples.at(-1);
    return { busy: true, confidence: "unknown", signals: [], reasons: [`Нагрузку компьютера сейчас определить нельзя${last?.error ? ` (${last.error})` : ""}: тяжёлая фоновая работа ждёт.`] };
  }
  const latest = fresh.at(-1)!;
  const own = new Set(options.ownProcessNames.map(name => name.toLowerCase()));
  // Averages over the recent samples: one spike does not stop work, one quiet moment does not start it.
  const byPid = new Map<number, ProcessActivity & { samples: number }>();
  for (const sample of fresh) for (const item of sample.processes) {
    const entry = byPid.get(item.pid) ?? { ...item, gpuPercent: 0, cpuPercent: 0, vramMiB: 0, samples: 0 };
    entry.gpuPercent += item.gpuPercent; entry.cpuPercent += item.cpuPercent; entry.vramMiB = Math.max(entry.vramMiB, item.vramMiB); entry.samples += 1;
    byPid.set(item.pid, entry);
  }
  const average = [...byPid.values()].map(item => ({ ...item, gpuPercent: item.gpuPercent / fresh.length, cpuPercent: item.cpuPercent / fresh.length }));
  const reasons: string[] = [];
  const signals: string[] = [];
  for (const render of latest.renders) reasons.push(`Идёт ${render.detail} (pid ${render.pid}).`);
  for (const app of options.ownerApps) {
    const processes = average.filter(item => item.name === app.toLowerCase());
    const open = processes.length > 0 || latest.processes.some(item => item.name === app.toLowerCase());
    if (!open) continue;
    const gpu = processes.reduce((sum, item) => sum + item.gpuPercent, 0);
    const cpu = processes.reduce((sum, item) => sum + item.cpuPercent, 0);
    const vram = processes.reduce((sum, item) => sum + item.vramMiB, 0);
    if (gpu >= thresholds.appGpuPercent || cpu >= thresholds.appCpuPercent) reasons.push(`${app} активно работает: GPU ${Math.round(gpu)}%, CPU ${Math.round(cpu)}%, VRAM ${(vram / 1024).toFixed(1)} ГБ.`);
    else signals.push(`${app} открыт и простаивает (GPU ${Math.round(gpu)}%, CPU ${Math.round(cpu)}%): не мешает.`);
  }
  const known = new Set([...options.ownerApps.map(name => name.toLowerCase()), ...own]);
  for (const item of average) {
    if (known.has(item.name) || item.name === "idle" || item.name === "system") continue;
    const gpuHeavy = !options.heavyLeaseActive && item.gpuPercent >= thresholds.externalGpuPercent;
    const vramHeavy = item.vramMiB >= thresholds.externalVramMiB && item.gpuPercent >= thresholds.appGpuPercent;
    if (gpuHeavy || vramHeavy) reasons.push(`Высокая нагрузка от ${item.name} (pid ${item.pid}): GPU ${Math.round(item.gpuPercent)}%, VRAM ${(item.vramMiB / 1024).toFixed(1)} ГБ.`);
  }
  const cpuAverage = fresh.reduce((sum, sample) => sum + (sample.totalCpuPercent ?? 0), 0) / fresh.length;
  if (cpuAverage >= thresholds.totalCpuPercent) reasons.push(`Процессор загружен на ${Math.round(cpuAverage)}%.`);
  return { busy: reasons.length > 0, confidence: "measured", reasons, signals, sampledAt: latest.at };
}

/** Keeps the last few samples; refreshed in the background so admission never waits for PowerShell. */
export class ActivityMonitor {
  private samples: ActivitySample[] = [];
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(private readonly probe: () => Promise<ActivitySample> = sampleActivity, private readonly intervalMs = 15_000) {}

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  refresh(): Promise<void> {
    this.running ??= this.probe().then(sample => { this.samples = [...this.samples, sample].slice(-6); }).catch(() => undefined).finally(() => { this.running = undefined; });
    return this.running;
  }

  recent(): ActivitySample[] { return [...this.samples]; }
  push(sample: ActivitySample): void { this.samples = [...this.samples, sample].slice(-6); }
}
