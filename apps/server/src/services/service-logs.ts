import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, ftruncateSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../server-paths";

/*
 * Read-only access to the console output of local services for the Мастерская terminals.
 * Sources are plain files: logs SnarkRoute writes for the processes it launches ("managed",
 * rotated here) and logs services keep themselves ("own-file", never touched). Nothing here
 * executes commands or attaches to foreign processes; text is redacted before it leaves.
 */

export type ServiceLogOwner = "managed" | "own-file";

export type ServiceLogSourceDef = {
  id: string;
  title: string;
  path?: string;
  owner: ServiceLogOwner;
  note?: string;
};

export type ServiceLogContext = { online?: boolean };

export type ServiceLogProvider = {
  id: string;
  label: string;
  order?: number;
  sources: (context: ServiceLogContext) => ServiceLogSourceDef[];
  /** Hidden from the terminals until one of its sources exists (on-demand dev servers). */
  onlyWhenPresent?: boolean;
};

export type ServiceLogSourceSummary = {
  id: string;
  title: string;
  owner: ServiceLogOwner;
  path?: string;
  available: boolean;
  size: number;
  updatedAt?: string;
  note?: string;
  /** Changes whenever a newer error line appears; the UI compares it with what was already seen. */
  errorMark?: string;
  lastError?: string;
};

export type ServiceLogSummary = {
  id: string;
  label: string;
  online?: boolean;
  logsAvailable: boolean;
  note?: string;
  sources: ServiceLogSourceSummary[];
};

export type ServiceLogChunk = {
  serviceId: string;
  sourceId: string;
  path?: string;
  available: boolean;
  text: string;
  cursor: number;
  size: number;
  reset: boolean;
  updatedAt?: string;
};

export const LOG_MAX_BYTES = 8 * 1024 * 1024;
export const LOG_KEEP = 3;
const INITIAL_TAIL_BYTES = 64 * 1024;
const CHUNK_BYTES = 256 * 1024;

export const ERROR_LINE = /\b(?:error|errors|fatal|critical|panic|exception|traceback|failed|failure|unhandled)\b|fullyqualifiederrorid|ошибк|не удалось|сбой/i;
export const NOT_ERROR_LINE = /\b(?:0|no|zero) errors?\b|\berrors?\s*[=:]\s*0\b|\berror\s*[=:]\s*(?:""|null|none)/i;
const EXCEPTION_NAME = /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/;
export const WARNING_LINE = /\bwarn(?:ing)?s?\b|deprecat|предупрежд/i;

export function serviceLogsDir(): string {
  return join(repoRoot, "apps", "server", "data", "logs");
}

export function managedLogPath(name: string): string {
  return join(serviceLogsDir(), `${name}.log`);
}

/* ---------- registry ---------- */

const providers = new Map<string, ServiceLogProvider>();
/** Last online state seen by the summary poll, so per-second chunk reads need no runtime probe. */
const lastKnownOnline = new Map<string, boolean>();

export function registerServiceLogProvider(provider: ServiceLogProvider): void {
  providers.set(provider.id, provider);
}

export function serviceLogProvider(id: string): ServiceLogProvider | undefined {
  return providers.get(id);
}

export function clearServiceLogProvidersForTests(): void {
  providers.clear();
  markCache.clear();
  lastKnownOnline.clear();
}

/**
 * Lists every service known to the runtime registry plus the log-only providers. A runtime
 * without log sources still gets an entry that says why its output is not available.
 */
export function listServiceLogs(runtimes: Array<{ id: string; label: string; online?: boolean }>): ServiceLogSummary[] {
  const seen = new Set<string>();
  const result: ServiceLogSummary[] = [];
  const ordered = [...providers.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const runtimeById = new Map(runtimes.map(runtime => [runtime.id, runtime]));
  const add = (id: string, label: string, online: boolean | undefined, provider?: ServiceLogProvider) => {
    if (seen.has(id)) return;
    if (online !== undefined) lastKnownOnline.set(id, online);
    const sources = provider ? safeSources(provider, { online }).map(source => summarizeSource(source)) : [];
    if (provider?.onlyWhenPresent && !sources.some(source => source.available)) return;
    seen.add(id);
    result.push({
      id,
      label,
      ...(online === undefined ? {} : { online }),
      logsAvailable: sources.some(source => source.available),
      ...(sourcesNote(sources, online) ?? (!provider
        ? { note: "Мастерская не запускает этот процесс и не знает его журнала: stdout/stderr внешнего процесса недоступен." }
        : {})),
      sources
    });
  };
  for (const provider of ordered) if ((provider.order ?? 50) < 20) add(provider.id, provider.label, runtimeById.get(provider.id)?.online, provider);
  for (const runtime of runtimes) add(runtime.id, runtime.label, runtime.online, providers.get(runtime.id));
  for (const provider of ordered) add(provider.id, provider.label, runtimeById.get(provider.id)?.online, provider);
  return result;
}

function safeSources(provider: ServiceLogProvider, context: ServiceLogContext): ServiceLogSourceDef[] {
  try { return provider.sources(context); }
  catch { return []; }
}

function sourcesNote(sources: ServiceLogSourceSummary[], online: boolean | undefined): { note: string } | undefined {
  if (!sources.length) return undefined;
  if (!sources.some(source => source.available)) {
    return { note: online ? "Процесс работает, но запущен вне Мастерской: его stdout/stderr недоступен. Журнал появится после запуска из Мастерской." : "Журнал появится после первого запуска." };
  }
  if (!online) return undefined;
  const managed = sources.filter(source => source.owner === "managed" && source.available);
  if (!managed.length || sources.some(source => source.owner === "own-file" && source.available)) return undefined;
  const launches = managed.map(source => source.path ? readLaunchMarker(source.path) : undefined);
  if (launches.some(launch => launch?.pid && pidAlive(launch.pid))) return undefined;
  return { note: "Текущий процесс запущен не фоновым запуском Мастерской (вручную, другим лаунчером или до обновления): его вывод может не попадать сюда. Показан журнал последнего запуска из Мастерской." };
}

function readLaunchMarker(path: string): { pid?: number; startedAt?: string } | undefined {
  try { return JSON.parse(readFileSync(`${path}.launch.json`, "utf8")); }
  catch { return undefined; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/* ---------- summaries and error marks ---------- */

const markCache = new Map<string, { size: number; mtimeMs: number; mark?: string; line?: string }>();

function summarizeSource(source: ServiceLogSourceDef): ServiceLogSourceSummary {
  const base = { id: source.id, title: source.title, owner: source.owner, ...(source.path ? { path: source.path } : {}), ...(source.note ? { note: source.note } : {}) };
  if (!source.path) return { ...base, available: false, size: 0 };
  try {
    const stat = statSync(source.path);
    if (!stat.isFile()) return { ...base, available: false, size: 0 };
    const error = errorMark(source.path, stat.size, stat.mtimeMs);
    return {
      ...base,
      available: true,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      ...(error.mark ? { errorMark: error.mark, lastError: error.line } : {})
    };
  } catch {
    return { ...base, available: false, size: 0 };
  }
}

function errorMark(path: string, size: number, mtimeMs: number): { mark?: string; line?: string } {
  const cached = markCache.get(path);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached;
  const start = Math.max(0, size - INITIAL_TAIL_BYTES);
  const text = decodeLogBuffer(readRange(path, start, size));
  const lines = text.split(/\r\n|\r|\n/);
  let offset = start + Buffer.byteLength(text, "utf8");
  let found: { mark?: string; line?: string } = {};
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    offset -= Buffer.byteLength(line, "utf8") + 1;
    if (isErrorLine(line)) {
      // Keyed by the line's position and text: stable while the file only grows, new for a new error.
      found = { mark: `${Math.max(0, offset)}:${hash(line)}`, line: redactLogText(line.trim()).slice(0, 240) };
      break;
    }
  }
  const entry = { size, mtimeMs, ...found };
  markCache.set(path, entry);
  return entry;
}

const LEVEL_FIELD = /\blevel["']?\s*[=:]\s*["']?([a-z]+|\d{2})\b/i;
const LEVEL_TOKEN = /(?:^|[\s[|(,])(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|CRITICAL|FATAL|PANIC)(?=[\s\]:|)]|$)/;

/** A line's own log level wins (level=INFO, "level":50, "INFO:", "[ERROR]"); otherwise keywords decide. */
export function classifyLogLine(line: string): "error" | "warn" | "" {
  const explicit = (LEVEL_FIELD.exec(line)?.[1] ?? LEVEL_TOKEN.exec(line)?.[1])?.toLowerCase();
  if (explicit) {
    if (/^(?:error|err|critical|fatal|panic|50|60)$/.test(explicit)) return "error";
    if (/^(?:warn|warning|40)$/.test(explicit)) return "warn";
    if (/^(?:trace|debug|info|notice|10|20|30)$/.test(explicit)) return "";
  }
  if ((ERROR_LINE.test(line) || EXCEPTION_NAME.test(line)) && !NOT_ERROR_LINE.test(line)) return "error";
  return WARNING_LINE.test(line) ? "warn" : "";
}

export function isErrorLine(line: string): boolean {
  return classifyLogLine(line) === "error";
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36);
}

/* ---------- reading ---------- */

export function readServiceLogChunk(serviceId: string, sourceId: string, cursor: number | undefined, context: ServiceLogContext = {}): ServiceLogChunk {
  const provider = providers.get(serviceId);
  if (!provider) throw new Error("Для этого процесса журнал не зарегистрирован.");
  const online = context.online ?? lastKnownOnline.get(serviceId);
  const source = safeSources(provider, { ...context, online }).find(entry => entry.id === sourceId);
  if (!source) throw new Error("Источник журнала не найден.");
  const empty = { serviceId, sourceId, ...(source.path ? { path: source.path } : {}), text: "", cursor: 0, size: 0, reset: false };
  if (!source.path || !existsSync(source.path)) return { ...empty, available: false };
  const stat = statSync(source.path);
  const size = stat.size;
  let start: number;
  let reset = false;
  if (cursor === undefined || !Number.isFinite(cursor) || cursor < 0) {
    start = Math.max(0, size - INITIAL_TAIL_BYTES);
  } else if (cursor > size) {
    start = 0; // rotated or truncated since the last read
    reset = true;
  } else {
    start = cursor;
  }
  const end = Math.min(size, start + CHUNK_BYTES);
  let buffer = readRange(source.path, start, end);
  if (cursor === undefined || cursor < 0) {
    // Start the first view on a whole line.
    const newline = start > 0 ? buffer.indexOf(10) : -1;
    if (newline >= 0) { buffer = buffer.subarray(newline + 1); start += newline + 1; }
  }
  // Hand out whole lines only; a partial last line is returned once it is finished
  // (or once it is long enough that waiting would stall the view).
  let consumed = buffer.length;
  const lastBreak = Math.max(buffer.lastIndexOf(10), buffer.lastIndexOf(13));
  if (lastBreak >= 0 && lastBreak < buffer.length - 1 && buffer.length - lastBreak < 4096) consumed = lastBreak + 1;
  else if (lastBreak < 0 && buffer.length < 4096) consumed = 0;
  const text = redactLogText(decodeLogBuffer(buffer.subarray(0, consumed)));
  return {
    ...empty,
    available: true,
    text,
    cursor: start + consumed,
    size,
    reset,
    updatedAt: stat.mtime.toISOString()
  };
}

function readRange(path: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  if (!length) return buffer;
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** UTF-8 when valid; otherwise the Windows code page that yields real Cyrillic (ANSI 1251 or OEM 866). */
export function decodeLogBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  const candidates = ["windows-1251", "ibm866"].flatMap(encoding => {
    try { return [new TextDecoder(encoding).decode(buffer)]; } catch { return []; }
  });
  const score = (text: string) => (text.match(/[а-яё]/gi)?.length ?? 0) - (text.match(/[╬╫╪┘┌▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═]/g)?.length ?? 0) * 3;
  return candidates.sort((a, b) => score(b) - score(a))[0] ?? utf8;
}

/* ---------- redaction ---------- */

/** Read on every call: some tokens (H3) are put into process.env while the server runs. */
function currentSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL)/i.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export function redactLogText(text: string): string {
  let result = text;
  for (const value of currentSecretValues()) if (result.includes(value)) result = result.split(value).join("[скрыто]");
  return result
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[скрыт приватный ключ]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[скрыто]")
    .replace(/\b(?:hf|r8)_[A-Za-z0-9]{16,}/g, "[скрыто]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[скрыто]")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[скрыто]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[скрыто]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[скрыто]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [скрыто]")
    .replace(/\b(Authorization\s*[:=]\s*)(?:Basic|Token)\s+[^\s"',;]+/gi, "$1[скрыто]")
    .replace(/([?&](?:token|key|api_key|apikey|access_token|secret|password|sig|signature)=)[^&\s"'#]+/gi, "$1[скрыто]")
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))(\s*[=:]\s*)("?)[^\s"',;]+/gi, "$1$2$3[скрыто]");
}

/* ---------- rotation of managed logs ---------- */

export function rotatedLogPath(path: string, generation: number): string {
  return /\.log$/i.test(path) ? path.replace(/\.log$/i, `.${generation}.log`) : `${path}.${generation}`;
}

/**
 * Copy-and-truncate rotation for a log that a running process keeps open. Our launches open
 * logs in shared append mode, so the writer continues at the new end without a gap.
 */
export function trimLiveLog(path: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return false;
    rmSync(rotatedLogPath(path, keep), { force: true });
    for (let generation = keep - 1; generation >= 1; generation--) {
      const from = rotatedLogPath(path, generation);
      if (existsSync(from)) renameSync(from, rotatedLogPath(path, generation + 1));
    }
    copyFileSync(path, rotatedLogPath(path, 1));
    const fd = openSync(path, "r+");
    try { ftruncateSync(fd, 0); } finally { closeSync(fd); }
    markCache.delete(path);
    return true;
  } catch {
    return false;
  }
}

let maintenance: NodeJS.Timeout | undefined;

export function trimManagedLogs(): void {
  for (const provider of providers.values()) {
    for (const source of safeSources(provider, {})) {
      if (source.owner === "managed" && source.path) trimLiveLog(source.path);
    }
  }
}

export function startServiceLogMaintenance(intervalMs = 60_000): void {
  if (maintenance) return;
  maintenance = setInterval(trimManagedLogs, intervalMs);
  maintenance.unref?.();
  trimManagedLogs();
}
