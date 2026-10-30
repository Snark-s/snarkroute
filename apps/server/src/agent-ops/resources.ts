import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import type { EffectiveMode } from "./computer-mode";

/**
 * One dispatcher for GPU/VRAM, RAM, CPU and heavy disk work. A lease is granted
 * synchronously after the telemetry read, so two callers can never both count
 * the same free VRAM. Estimates are refined from measured peaks; an expired
 * lease is checked against reality before it is released.
 */

export type ResourceClass = "heavy" | "light";

export type ResourceRequest = {
  holder: string;
  agentId: string;
  purpose: string;
  class: ResourceClass;
  origin: "owner" | "agent";
  vramMiB?: number;
  ramMiB?: number;
  cpuSlots?: number;
  diskHeavy?: boolean;
  runtimeId?: string;
  modelId?: string;
  contextTokens?: number;
  ttlMs?: number;
};

export type Lease = Required<Pick<ResourceRequest, "holder" | "agentId" | "purpose" | "class" | "origin">> & {
  id: string;
  vramMiB: number;
  ramMiB: number;
  cpuSlots: number;
  diskHeavy: boolean;
  runtimeId?: string;
  profileKey?: string;
  estimateSource: "measured" | "declared" | "default" | "none";
  grantedAt: string;
  heartbeatAt: string;
  ttlMs: number;
  state: "active" | "expired_unverified";
  baselineVramMiB?: number;
  baselineRamUsedMiB?: number;
  peakVramDeltaMiB: number;
  peakRamDeltaMiB: number;
};

export type Telemetry = {
  gpu?: { name: string; totalMiB: number; usedMiB: number; freeMiB: number; utilizationPercent: number };
  memory: { totalMiB: number; usedMiB: number; freeMiB: number };
  cpuCount: number;
  capturedAt: string;
};

export type ResourceProfile = { key: string; samples: number; peakVramMiB: number; peakRamMiB: number; lastObservedAt: string };

export type RuntimeAdmissionCheck = (runtimeId: string, modelId?: string) => Promise<{ allowed: boolean; requiresConfirmation: boolean; summary: string; blockers: string[]; warnings: string[] }>;

export type DispatcherDeps = {
  telemetry: () => Promise<Telemetry>;
  mode: () => Promise<EffectiveMode>;
  ownerApps: () => Promise<string[]>;
  runtimeAdmission?: RuntimeAdmissionCheck;
  declaredVramMiB?: (runtimeId: string) => number | undefined;
  /** Is the work behind an expired lease still alive (task process, runtime busy)? */
  stillActive?: (lease: Lease) => Promise<boolean>;
  persist?: (state: { leases: Lease[]; profiles: ResourceProfile[] }) => Promise<void>;
  now?: () => number;
};

export type Decision = { granted: true; lease: Lease } | { granted: false; waitFor: "window" | "resources"; reason: string };

const DEFAULT_HEAVY_VRAM_MiB = 8192;
const DEFAULT_TTL_MS = 10 * 60_000;
const LIGHT_RAM_FLOOR_MiB = 2048;

export class ResourceDispatcher {
  private leases = new Map<string, Lease>();
  private profiles = new Map<string, ResourceProfile>();
  private lastHeavyRuntime?: { runtimeId: string; releasedAt: number };

  constructor(private readonly deps: DispatcherDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  restore(state: { leases?: Lease[]; profiles?: ResourceProfile[] }): void {
    // After a restart every lease is unverified until its holder is reconciled; none is dropped blindly.
    for (const lease of state.leases ?? []) this.leases.set(lease.id, { ...lease, state: "expired_unverified" });
    for (const profile of state.profiles ?? []) this.profiles.set(profile.key, profile);
  }

  list(): Lease[] { return [...this.leases.values()]; }
  listProfiles(): ResourceProfile[] { return [...this.profiles.values()]; }
  get(id: string): Lease | undefined { return this.leases.get(id); }
  /** Recheck the owner's mode before another generation of the SAME admitted
   * workload. Retain its reservation; resident weights are not a new allocation. */
  async continueLease(id: string): Promise<{allowed:boolean;reason?:string}> {
    const lease=this.leases.get(id); if (!lease || lease.state!=="active") return {allowed:false,reason:"Резерв уже не активен; требуется новая аренда."};
    const [mode,apps,telemetry]=await Promise.all([this.deps.mode(),this.deps.ownerApps(),this.deps.telemetry()]);
    if (lease.origin==="agent" && lease.class==="heavy") {
      if (!mode.limits.heavy) return {allowed:false,reason:`Режим «${mode.label}»: следующая генерация ждёт.`};
      if (mode.mode==="background" && apps.length) return {allowed:false,reason:`Запущены приложения владельца: ${apps.join(", ")}.`};
      if (telemetry.gpu && telemetry.gpu.freeMiB<mode.limits.reserveVramMiB) return {allowed:false,reason:"Следующая генерация ждёт восстановления резерва VRAM владельца."};
      if (telemetry.memory.freeMiB<mode.limits.reserveRamMiB) return {allowed:false,reason:"Следующая генерация ждёт восстановления резерва RAM владельца."};
    }
    this.heartbeat(id); return {allowed:true};
  }
  recentHeavyRuntime(): string | undefined {
    return this.lastHeavyRuntime && this.now() - this.lastHeavyRuntime.releasedAt < 120_000 ? this.lastHeavyRuntime.runtimeId : undefined;
  }

  profileKey(request: Pick<ResourceRequest, "runtimeId" | "modelId" | "contextTokens">): string | undefined {
    if (!request.runtimeId) return undefined;
    const context = request.contextTokens ?? 0;
    const bucket = context <= 8192 ? "ctx8k" : context <= 32768 ? "ctx32k" : "ctx128k";
    return [request.runtimeId, request.modelId ?? "*", bucket].join("|");
  }

  /** VRAM estimate: measured peak (+15 %) beats the declared requirement, which beats a default. Never a guarantee. */
  estimate(request: ResourceRequest): { vramMiB: number; ramMiB: number; source: Lease["estimateSource"]; profileKey?: string } {
    const key = this.profileKey(request);
    const measured = key ? this.profiles.get(key) : undefined;
    const declared = request.runtimeId ? this.deps.declaredVramMiB?.(request.runtimeId) : undefined;
    if (request.vramMiB !== undefined) return { vramMiB: request.vramMiB, ramMiB: request.ramMiB ?? 0, source: "declared", profileKey: key };
    if (measured && measured.samples > 0) {
      return { vramMiB: Math.round(Math.max(measured.peakVramMiB * 1.15, declared ? declared * 0.5 : 0)), ramMiB: Math.round(Math.max(request.ramMiB ?? 0, measured.peakRamMiB * 1.15)), source: "measured", profileKey: key };
    }
    if (declared) return { vramMiB: declared, ramMiB: request.ramMiB ?? 0, source: "declared", profileKey: key };
    if (request.class === "heavy" && request.runtimeId) return { vramMiB: DEFAULT_HEAVY_VRAM_MiB, ramMiB: request.ramMiB ?? 0, source: "default", profileKey: key };
    return { vramMiB: 0, ramMiB: request.ramMiB ?? 0, source: "none", profileKey: key };
  }

  async acquire(request: ResourceRequest): Promise<Decision> {
    const [telemetry, mode, ownerApps] = await Promise.all([this.deps.telemetry(), this.deps.mode(), this.deps.ownerApps()]);
    const admission = request.runtimeId && request.class === "heavy" && this.deps.runtimeAdmission
      ? await this.deps.runtimeAdmission(request.runtimeId, request.modelId).catch(error => ({ allowed: false, requiresConfirmation: false, summary: String(error instanceof Error ? error.message : error), blockers: [], warnings: [] }))
      : undefined;
    await this.expireStale();
    // Everything below is synchronous: the check and the insert cannot interleave with another caller.
    const denial = this.check(request, telemetry, mode, ownerApps, admission);
    if (denial) return denial;
    const estimate = this.estimate(request);
    const at = new Date(this.now()).toISOString();
    const lease: Lease = {
      id: randomUUID(), holder: request.holder, agentId: request.agentId, purpose: request.purpose, class: request.class, origin: request.origin,
      vramMiB: estimate.vramMiB, ramMiB: estimate.ramMiB, cpuSlots: request.cpuSlots ?? (request.class === "heavy" ? 2 : 1), diskHeavy: request.diskHeavy ?? false,
      runtimeId: request.runtimeId, profileKey: estimate.profileKey, estimateSource: estimate.source, grantedAt: at, heartbeatAt: at,
      ttlMs: request.ttlMs ?? DEFAULT_TTL_MS, state: "active",
      baselineVramMiB: telemetry.gpu?.usedMiB, baselineRamUsedMiB: telemetry.memory.usedMiB, peakVramDeltaMiB: 0, peakRamDeltaMiB: 0
    };
    this.leases.set(lease.id, lease);
    void this.save();
    return { granted: true, lease };
  }

  private check(request: ResourceRequest, telemetry: Telemetry, mode: EffectiveMode, ownerApps: string[],
    admission?: { allowed: boolean; requiresConfirmation: boolean; summary: string }): Extract<Decision, { granted: false }> | undefined {
    const limits = mode.limits;
    const active = this.list();
    const heavyActive = active.filter(lease => lease.class === "heavy");
    if (request.class === "heavy") {
      if (!limits.heavy && request.origin === "agent") return { granted: false, waitFor: "window", reason: `Режим «${mode.label}»: тяжёлые фоновые задачи ждут (${mode.reason}).` };
      if (request.origin === "agent" && mode.mode === "background" && ownerApps.length) {
        return { granted: false, waitFor: "window", reason: `Запущены приложения владельца (${ownerApps.join(", ")}): в фоновом режиме тяжёлые задачи ждут.` };
      }
      if (heavyActive.length >= Math.max(limits.maxHeavy, request.origin === "owner" ? 1 : 0)) {
        return { granted: false, waitFor: "resources", reason: `Тяжёлый слот занят: ${heavyActive.map(lease => lease.purpose).join(", ")}.` };
      }
      if (request.runtimeId && heavyActive.some(lease => lease.runtimeId === request.runtimeId)) {
        return { granted: false, waitFor: "resources", reason: `Рантайм ${request.runtimeId} уже занят другой задачей.` };
      }
      if (admission && (!admission.allowed || admission.requiresConfirmation && request.origin === "agent")) {
        return { granted: false, waitFor: "resources", reason: admission.summary };
      }
    } else if (request.origin === "agent" && active.filter(lease => lease.class === "light" && lease.origin === "agent").length >= limits.maxLight) {
      return { granted: false, waitFor: "resources", reason: `Лимит лёгких фоновых задач в режиме «${mode.label}»: ${limits.maxLight}.` };
    }
    const estimate = this.estimate(request);
    if (estimate.vramMiB > 0) {
      if (!telemetry.gpu) return { granted: false, waitFor: "resources", reason: "Телеметрия GPU недоступна: выделить видеопамять безопасно нельзя." };
      const reserve = request.origin === "owner" ? 0 : Math.min(limits.reserveVramMiB, telemetry.gpu.totalMiB);
      const free = telemetry.gpu.totalMiB - telemetry.gpu.usedMiB - this.outstandingVram(telemetry) - reserve;
      if (estimate.vramMiB > free) {
        return { granted: false, waitFor: request.origin === "agent" && limits.reserveVramMiB >= telemetry.gpu.totalMiB ? "window" : "resources",
          reason: `Нужно ~${gib(estimate.vramMiB)} VRAM (${estimateLabel(estimate.source)}), доступно ${gib(Math.max(0, free))} с учётом резерва ${gib(reserve)} и чужих резервов.` };
      }
    }
    if (estimate.ramMiB > 0) {
      // The full owner reserve guards against heavy work; light work (a CLI, a test run) only keeps the critical floor.
      const reserve = request.origin === "owner" ? 0 : request.class === "heavy" ? limits.reserveRamMiB : Math.min(limits.reserveRamMiB, LIGHT_RAM_FLOOR_MiB);
      const free = telemetry.memory.freeMiB - this.outstandingRam(telemetry) - reserve;
      if (estimate.ramMiB > free) return { granted: false, waitFor: "resources", reason: `Нужно ~${gib(estimate.ramMiB)} RAM, доступно ${gib(Math.max(0, free))} с учётом резерва ${gib(reserve)}.` };
    }
    const slots = request.cpuSlots ?? (request.class === "heavy" ? 2 : 1);
    const cpuBudget = Math.max(1, Math.floor(telemetry.cpuCount * (1 - (request.origin === "owner" ? 0 : limits.reserveCpuPercent / 100))));
    const used = active.reduce((sum, lease) => sum + lease.cpuSlots, 0);
    if (used + slots > cpuBudget) return { granted: false, waitFor: "resources", reason: `CPU: занято ${used} из ${cpuBudget} разрешённых потоков.` };
    if (request.diskHeavy && active.some(lease => lease.diskHeavy)) return { granted: false, waitFor: "resources", reason: "Тяжёлая работа с диском уже идёт." };
    return undefined;
  }

  /** VRAM promised to leases but not yet visible in the measured usage. */
  private outstandingVram(telemetry: Telemetry): number {
    return this.list().reduce((sum, lease) => {
      const seen = telemetry.gpu && lease.baselineVramMiB !== undefined ? Math.max(0, telemetry.gpu.usedMiB - lease.baselineVramMiB) : 0;
      return sum + Math.max(0, lease.vramMiB - seen);
    }, 0);
  }

  private outstandingRam(telemetry: Telemetry): number {
    return this.list().reduce((sum, lease) => {
      const seen = lease.baselineRamUsedMiB !== undefined ? Math.max(0, telemetry.memory.usedMiB - lease.baselineRamUsedMiB) : 0;
      return sum + Math.max(0, lease.ramMiB - seen);
    }, 0);
  }

  heartbeat(id: string): boolean {
    const lease = this.leases.get(id);
    if (!lease) return false;
    lease.heartbeatAt = new Date(this.now()).toISOString();
    lease.state = "active";
    return true;
  }

  /** Records measured peaks while a lease is active; called by the telemetry sampler. */
  observe(telemetry: Telemetry): void {
    for (const lease of this.leases.values()) {
      if (telemetry.gpu && lease.baselineVramMiB !== undefined) lease.peakVramDeltaMiB = Math.max(lease.peakVramDeltaMiB, telemetry.gpu.usedMiB - lease.baselineVramMiB);
      if (lease.baselineRamUsedMiB !== undefined) lease.peakRamDeltaMiB = Math.max(lease.peakRamDeltaMiB, telemetry.memory.usedMiB - lease.baselineRamUsedMiB);
    }
  }

  release(id: string, options: { measured?: boolean } = {}): Lease | undefined {
    const lease = this.leases.get(id);
    if (!lease) return undefined;
    this.leases.delete(id);
    if (lease.class === "heavy" && lease.runtimeId) this.lastHeavyRuntime = { runtimeId: lease.runtimeId, releasedAt: this.now() };
    if (options.measured !== false && lease.profileKey && lease.peakVramDeltaMiB > 256) {
      const previous = this.profiles.get(lease.profileKey);
      this.profiles.set(lease.profileKey, {
        key: lease.profileKey,
        samples: (previous?.samples ?? 0) + 1,
        // The newest measurement dominates, but one light run cannot erase a known heavy peak.
        peakVramMiB: Math.round(previous ? Math.max(lease.peakVramDeltaMiB, previous.peakVramMiB * 0.7 + lease.peakVramDeltaMiB * 0.3) : lease.peakVramDeltaMiB),
        peakRamMiB: Math.round(Math.max(lease.peakRamDeltaMiB, previous?.peakRamMiB ?? 0)),
        lastObservedAt: new Date(this.now()).toISOString()
      });
    }
    void this.save();
    return lease;
  }

  releaseHolder(holder: string): number {
    let released = 0;
    for (const lease of this.list()) if (lease.holder === holder) { this.release(lease.id); released += 1; }
    return released;
  }

  /** A lease past its TTL is not freed until its holder is confirmed gone. */
  async expireStale(): Promise<void> {
    const now = this.now();
    for (const lease of this.list()) {
      if (now - Date.parse(lease.heartbeatAt) <= lease.ttlMs && lease.state === "active") continue;
      lease.state = "expired_unverified";
      const alive = await (this.deps.stillActive?.(lease) ?? Promise.resolve(true)).catch(() => true);
      if (alive) { lease.heartbeatAt = new Date(now).toISOString(); continue; }
      this.release(lease.id, { measured: false });
    }
  }

  private async save(): Promise<void> {
    await this.deps.persist?.({ leases: this.list(), profiles: this.listProfiles() }).catch(() => undefined);
  }
}

export function defaultCpuCount(): number { return Math.max(1, cpus().length); }

function gib(mib: number): string { return `${(mib / 1024).toFixed(1)} ГБ`; }
function estimateLabel(source: Lease["estimateSource"]): string {
  return source === "measured" ? "по измерениям" : source === "declared" ? "заявлено" : source === "default" ? "оценка по умолчанию" : "без GPU";
}
