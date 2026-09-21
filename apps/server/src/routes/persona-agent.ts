import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { errorMessage } from "../services/errors";

type JsonObject = Record<string, unknown>;
const taskIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const imageTypes = new Map([["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"], ["image/gif", ".gif"]]);
type PersonaImageUpload = { name?: string; mimeType?: string; dataBase64?: string };
type PersonaProgressEvent = { at: string; kind: string; message: string };
type PersonaJob = {
  jobId: string;
  taskId: string;
  status: "running" | "complete" | "failed" | "cancelled";
  events: PersonaProgressEvent[];
  startedAt: string;
  updatedAt: string;
  clientHeartbeatAt: string;
  result?: JsonObject | unknown[];
  error?: string;
};
const personaJobs = new Map<string, PersonaJob>();
const personaJobProcesses = new Map<string, ChildProcess>();
const personaJobWatchdogs = new Map<string, NodeJS.Timeout>();
const configuredPersonaClientLeaseMs = Number(process.env.PERSONA_CLIENT_LEASE_MS ?? 300_000);
const personaClientLeaseMs = Number.isFinite(configuredPersonaClientLeaseMs) ? Math.max(30_000, configuredPersonaClientLeaseMs) : 300_000;
const personaOutputLimitBytes = 8 * 1024 * 1024;
const personaDiagnosticLimit = 128 * 1024;
const personaEventMessageLimit = 12_000;

export function personaHome(): string | undefined {
  const candidates = [
    process.env.PERSONA_HOME,
    process.platform === "win32" ? "I:\\PersonaCore" : undefined,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "PersonaCore") : undefined
  ].filter((value): value is string => Boolean(value));
  return candidates.map((candidate) => resolve(candidate)).find((candidate) =>
    existsSync(join(candidate, "scripts", "agent_task.py"))
  );
}

export async function registerPersonaAgentRoutes(app: FastifyInstance) {
  app.get("/api/persona/status", async () => {
    const home = personaHome();
    return { ok: true, available: Boolean(home), home };
  });

  app.get("/api/persona/tasks", async (_request, reply) => personaCall(reply, ["agent_task.py", "list"]));
  app.get<{ Params: { taskId: string } }>("/api/persona/tasks/:taskId", async (request, reply) => {
    assertTaskId(request.params.taskId);
    return personaCall(reply, ["agent_task.py", "show", request.params.taskId]);
  });
  app.delete<{ Params: { taskId: string } }>("/api/persona/tasks/:taskId", async (request, reply) => {
    assertTaskId(request.params.taskId);
    return personaCall(reply, ["agent_task.py", "delete", request.params.taskId]);
  });
  app.post<{ Body: { objective?: string; taskId?: string } }>("/api/persona/tasks", async (request, reply) => {
    const objective = request.body?.objective?.trim();
    if (!objective) return reply.code(400).send({ ok: false, error: "Objective is required." });
    const args = ["agent_task.py", "create", objective];
    if (request.body.taskId) {
      assertTaskId(request.body.taskId);
      args.push("--task-id", request.body.taskId);
    }
    return personaCall(reply, args);
  });
  app.get("/api/persona/projects", async (_request, reply) => personaCall(reply, ["list_projects.py", "--json"]));

  app.post<{ Body: { taskId?: string; objective?: string; matchingTask?: boolean } }>("/api/persona/handoff", async (request, reply) => {
    const taskId = request.body?.taskId?.trim();
    if (!taskId) return reply.code(400).send({ ok: false, error: "Task id is required." });
    assertTaskId(taskId);
    const args = ["handoff_codex_task.py", request.body?.matchingTask ? "--matching-task" : "--latest", "--task-id", taskId];
    if (request.body?.objective?.trim()) args.push("--objective", request.body.objective.trim());
    return personaCall(reply, args);
  });

  app.post<{ Params: { taskId: string }; Body: { workspace?: string } }>("/api/persona/tasks/:taskId/continue-in-codex", async (request, reply) => {
    assertTaskId(request.params.taskId);
    const workspace = request.body?.workspace?.trim();
    if (!workspace || !existsSync(resolve(workspace))) {
      return reply.code(400).send({ ok: false, error: "Select an available project workspace." });
    }
    const home = personaHome();
    if (!home) return reply.code(503).send({ ok: false, error: "PersonaCore was not found. Set PERSONA_HOME or connect drive I:." });
    try {
      const result = await runPython(home, ["handoff_to_codex.py", request.params.taskId, "--workspace", resolve(workspace)]);
      if (!result || Array.isArray(result) || typeof result.prompt !== "string") throw new Error("PersonaCore returned an invalid Codex handoff.");
      const desktopExecutable = await findCodexDesktopExecutable();
      if (process.platform === "win32" && desktopExecutable) await repairWindowsCodexProtocol(desktopExecutable);
      const launch = codexLaunchSpec(resolve(workspace), result.prompt, request.params.taskId, desktopExecutable);
      await launchCodex(launch);
      return { ok: true, launched: true, launcher: launch.command, ...result, prompt: undefined };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Params: { taskId: string }; Body: { prompt?: string; model?: string; executionProvider?: string; providerModelId?: string; workspace?: string; allowWrite?: boolean; allowShell?: boolean; maxSteps?: number; attachments?: PersonaImageUpload[] } }>("/api/persona/tasks/:taskId/run", async (request, reply) => {
    assertTaskId(request.params.taskId);
    const { model, executionProvider, providerModelId } = request.body ?? {};
    if (!model?.trim() || !executionProvider?.trim() || !providerModelId?.trim()) {
      return reply.code(400).send({ ok: false, error: "Select a model and one of its available SnarkRoute routes." });
    }
    const maxSteps = Math.max(1, Math.min(50, Math.floor(Number(request.body?.maxSteps ?? 32))));
    const args = [
      "agent_task.py", "run", request.params.taskId,
      "--model", model.trim(),
      "--provider", executionProvider.trim(),
      "--provider-model", providerModelId.trim(),
      "--max-steps", String(maxSteps)
    ];
    if (request.body?.prompt?.trim()) args.push("--prompt", request.body.prompt.trim());
    if (request.body?.workspace?.trim()) args.push("--workspace", request.body.workspace.trim());
    if (request.body?.allowWrite) args.push("--allow-write");
    if (request.body?.allowShell) args.push("--allow-shell");
    const home = personaHome();
    if (!home) return reply.code(503).send({ ok: false, error: "PersonaCore was not found. Set PERSONA_HOME or connect drive I:." });
    try {
      const imagePaths = await savePersonaImages(home, request.params.taskId, request.body?.attachments ?? []);
      for (const imagePath of imagePaths) args.push("--image", imagePath);
      return await runPython(home, args);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Params: { taskId: string }; Body: { prompt?: string; model?: string; executionProvider?: string; providerModelId?: string; workspace?: string; allowWrite?: boolean; allowShell?: boolean; maxSteps?: number; attachments?: PersonaImageUpload[] } }>("/api/persona/tasks/:taskId/run/start", async (request, reply) => {
    assertTaskId(request.params.taskId);
    const { model, executionProvider, providerModelId } = request.body ?? {};
    if (!model?.trim() || !executionProvider?.trim() || !providerModelId?.trim()) {
      return reply.code(400).send({ ok: false, error: "Select a model and one of its available SnarkRoute routes." });
    }
    const home = personaHome();
    if (!home) return reply.code(503).send({ ok: false, error: "PersonaCore was not found. Set PERSONA_HOME or connect drive I:." });
    try {
      const maxSteps = Math.max(1, Math.min(50, Math.floor(Number(request.body?.maxSteps ?? 32))));
      const args = [
        "agent_task.py", "run", request.params.taskId,
        "--model", model.trim(), "--provider", executionProvider.trim(),
        "--provider-model", providerModelId.trim(), "--max-steps", String(maxSteps),
        "--progress-jsonl"
      ];
      if (request.body?.prompt?.trim()) args.push("--prompt", request.body.prompt.trim());
      if (request.body?.workspace?.trim()) args.push("--workspace", request.body.workspace.trim());
      if (request.body?.allowWrite) args.push("--allow-write");
      if (request.body?.allowShell) args.push("--allow-shell");
      const imagePaths = await savePersonaImages(home, request.params.taskId, request.body?.attachments ?? []);
      for (const imagePath of imagePaths) args.push("--image", imagePath);
      const job = startPersonaJob(home, request.params.taskId, args);
      return { ok: true, jobId: job.jobId, status: job.status };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get<{ Params: { jobId: string } }>("/api/persona/jobs/:jobId", async (request, reply) => {
    const job = personaJobs.get(request.params.jobId);
    if (!job) return reply.code(404).send({ ok: false, error: "Unknown or expired Persona job." });
    if (job.status === "running") job.clientHeartbeatAt = new Date().toISOString();
    return { ok: true, ...job };
  });

  app.get("/api/persona/jobs", async () => {
    const now = new Date().toISOString();
    const jobs = [...personaJobs.values()].filter((job) => job.status === "running");
    for (const job of jobs) job.clientHeartbeatAt = now;
    return { ok: true, jobs };
  });

  app.post<{ Params: { jobId: string } }>("/api/persona/jobs/:jobId/cancel", async (request, reply) => {
    const job = personaJobs.get(request.params.jobId);
    if (!job) return reply.code(404).send({ ok: false, error: "Unknown or expired Persona job." });
    if (job.status !== "running") return { ok: true, ...job };
    cancelPersonaJob(job, "Остановка запрошена. Прерываю локальный процесс и соединение с провайдером.");
    return { ok: true, ...job };
  });
}

function startPersonaJob(home: string, taskId: string, [script, ...args]: string[]): PersonaJob {
  const now = new Date().toISOString();
  const job: PersonaJob = { jobId: randomUUID(), taskId, status: "running", events: [], startedAt: now, updatedAt: now, clientHeartbeatAt: now };
  personaJobs.set(job.jobId, job);
  const child = spawn(process.env.PERSONA_PYTHON ?? "python", [join(home, "scripts", script), ...args], {
    cwd: home,
    env: { ...process.env, PERSONA_HOME: home, PYTHONUTF8: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  personaJobProcesses.set(job.jobId, child);
  const watchdog = setInterval(() => {
    if (job.status !== "running") return;
    if (Date.now() - Date.parse(job.clientHeartbeatAt) > personaClientLeaseMs) {
      cancelPersonaJob(job, "Связь с интерфейсом потеряна. Задача автоматически остановлена, чтобы не расходовать токены в фоне.");
    }
  }, Math.min(5_000, Math.floor(personaClientLeaseMs / 3)));
  watchdog.unref();
  personaJobWatchdogs.set(job.jobId, watchdog);
  let stdout = "";
  let stdoutBytes = 0;
  let stderr = "";
  let stderrRemainder = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (job.status !== "running") return;
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > personaOutputLimitBytes) {
      failPersonaJob(job, "Jabberwock returned more than 8 MB of state. The isolated worker was stopped before it could exhaust SnarkRoute memory.");
      return;
    }
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderrRemainder += chunk;
    const lines = stderrRemainder.split(/\r?\n/);
    stderrRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("PERSONA_PROGRESS ")) {
        try {
          const event = JSON.parse(line.slice("PERSONA_PROGRESS ".length)) as PersonaProgressEvent;
          if (event && typeof event.message === "string") appendPersonaEvent(job, event);
        } catch { stderr = boundedTail(`${stderr}${line}\n`, personaDiagnosticLimit); }
      } else if (line.trim()) stderr = boundedTail(`${stderr}${line}\n`, personaDiagnosticLimit);
      job.updatedAt = new Date().toISOString();
    }
  });
  child.once("error", (error) => {
    if (job.status === "cancelled") return;
    failPersonaJob(job, errorMessage(error));
  });
  child.once("close", (code) => {
    personaJobProcesses.delete(job.jobId);
    const watchdog = personaJobWatchdogs.get(job.jobId);
    if (watchdog) clearInterval(watchdog);
    personaJobWatchdogs.delete(job.jobId);
    if (job.status === "cancelled") {
      schedulePersonaJobExpiry(job.jobId);
      return;
    }
    if (job.status === "failed") {
      schedulePersonaJobExpiry(job.jobId);
      return;
    }
    if (stderrRemainder.trim()) stderr = boundedTail(`${stderr}${stderrRemainder}`, personaDiagnosticLimit);
    if (code !== 0) {
      job.status = "failed";
      job.error = summarizePersonaProcessError(stderr, stdout, code);
    } else {
      try {
        job.result = JSON.parse(stdout) as JsonObject | unknown[];
        job.status = "complete";
      } catch {
        job.status = "failed";
        job.error = `PersonaCore returned invalid JSON: ${stdout.slice(0, 300)}`;
      }
    }
    job.updatedAt = new Date().toISOString();
    schedulePersonaJobExpiry(job.jobId);
  });
  return job;
}

function cancelPersonaJob(job: PersonaJob, message: string): void {
  if (job.status !== "running") return;
  job.status = "cancelled";
  job.updatedAt = new Date().toISOString();
  appendPersonaEvent(job, { at: job.updatedAt, kind: "cancelled", message });
  personaJobProcesses.get(job.jobId)?.kill();
}

function failPersonaJob(job: PersonaJob, error: string): void {
  if (job.status !== "running") return;
  job.status = "failed";
  job.error = boundedTail(error, personaDiagnosticLimit);
  job.updatedAt = new Date().toISOString();
  appendPersonaEvent(job, { at: job.updatedAt, kind: "failed", message: job.error });
  personaJobProcesses.get(job.jobId)?.kill();
}

function appendPersonaEvent(job: PersonaJob, event: PersonaProgressEvent): void {
  const message = event.message.length <= personaEventMessageLimit
    ? event.message
    : `${event.message.slice(0, personaEventMessageLimit)}\n…сообщение сокращено для устойчивости интерфейса`;
  job.events = [...job.events, { ...event, message }].slice(-100);
}

function boundedTail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit);
}

export function summarizePersonaProcessError(stderr: string, stdout: string, code: number | null): string {
  const diagnostic = (stderr || stdout || `Persona process exited with code ${code ?? "unknown"}`).trim();
  const lastLine = diagnostic.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? diagnostic;
  return boundedTail(lastLine.replace(/^(?:RuntimeError|ValueError|KeyError|Error):\s*/i, ""), personaDiagnosticLimit);
}

function schedulePersonaJobExpiry(jobId: string): void {
  setTimeout(() => personaJobs.delete(jobId), 30 * 60 * 1000).unref?.();
}

export function decodePersonaImageUpload(upload: PersonaImageUpload): { buffer: Buffer; extension: string } {
  const mimeType = upload.mimeType?.toLowerCase() ?? "";
  const extension = imageTypes.get(mimeType);
  if (!extension) throw new Error("Supported image types: PNG, JPEG, WebP and GIF.");
  const encoded = String(upload.dataBase64 ?? "").replace(/^data:[^;,]+;base64,/i, "");
  if (!encoded || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid image data.");
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length) throw new Error("The image is empty.");
  if (buffer.length > 10 * 1024 * 1024) throw new Error("Each image must be 10 MB or smaller.");
  return { buffer, extension };
}

async function savePersonaImages(home: string, taskId: string, uploads: PersonaImageUpload[]): Promise<string[]> {
  if (!Array.isArray(uploads)) throw new Error("Attachments must be an array.");
  if (uploads.length > 8) throw new Error("No more than 8 images can be attached at once.");
  if (!uploads.length) return [];
  const taskRoot = join(home, "data", "runtime", "agent", "tasks", taskId);
  if (!existsSync(join(taskRoot, "state.json"))) throw new Error(`Unknown Persona task: ${taskId}`);
  const target = join(taskRoot, "artifacts", "attachments");
  await mkdir(target, { recursive: true });
  const stamp = Date.now();
  const paths: string[] = [];
  for (const [index, upload] of uploads.entries()) {
    const { buffer, extension } = decodePersonaImageUpload(upload);
    const original = String(upload.name ?? "image").replace(extname(String(upload.name ?? "")), "");
    const safeName = original.replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "image";
    const path = join(target, `${stamp}-${index + 1}-${safeName}${extension}`);
    await writeFile(path, buffer, { flag: "wx" });
    paths.push(path);
  }
  return paths;
}

function assertTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId)) throw new Error("Invalid task id.");
}

export function codexLaunchSpec(workspace: string, prompt: string, _taskId: string, desktopExecutable?: string): { command: string; args: string[] } {
  const deepLink = new URL("codex://threads/new");
  deepLink.searchParams.set("path", workspace);
  deepLink.searchParams.set("prompt", prompt);
  deepLink.searchParams.set("mode", "work");
  if (process.platform === "win32") {
    if (!desktopExecutable || !existsSync(desktopExecutable)) {
      throw new Error("The current Codex Desktop executable was not found. Reinstall or update Codex Desktop.");
    }
    return { command: "explorer.exe", args: [deepLink.toString()] };
  }
  if (process.platform === "darwin") return { command: "open", args: [deepLink.toString()] };
  return { command: "xdg-open", args: [deepLink.toString()] };
}

async function findCodexDesktopExecutable(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const configured = process.env.CODEX_DESKTOP_EXECUTABLE?.trim();
  if (configured && existsSync(configured)) return configured;
  try {
    const packageRoot = String(await execText("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation)"
    ])).trim();
    const executable = packageRoot ? join(packageRoot, "app", "Codex.exe") : "";
    if (executable && existsSync(executable)) return executable;
  } catch {
    // The explicit error from codexLaunchSpec is more useful than PowerShell diagnostics here.
  }
  return undefined;
}

async function repairWindowsCodexProtocol(desktopExecutable: string): Promise<void> {
  const commandKey = "HKCU\\Software\\Classes\\codex\\shell\\open\\command";
  const commandValue = `"${desktopExecutable}" "%1"`;
  await execText("reg.exe", ["add", commandKey, "/ve", "/d", commandValue, "/f"]);
}

function launchCodex(spec: { command: string; args: string[] }): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolvePromise(); });
  });
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolvePromise(stdout);
    });
  });
}

async function personaCall(reply: { code(status: number): { send(value: unknown): unknown } }, args: string[]) {
  const home = personaHome();
  if (!home) return reply.code(503).send({ ok: false, error: "PersonaCore was not found. Set PERSONA_HOME or connect drive I:." });
  try {
    return await runPython(home, args);
  } catch (error) {
    return reply.code(400).send({ ok: false, error: errorMessage(error) });
  }
}

function runPython(home: string, [script, ...args]: string[]): Promise<JsonObject | unknown[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.env.PERSONA_PYTHON ?? "python",
      [join(home, "scripts", script), ...args],
      { cwd: home, env: { ...process.env, PERSONA_HOME: home, PYTHONUTF8: "1" }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
        try { resolvePromise(JSON.parse(stdout)); }
        catch { reject(new Error(`PersonaCore returned invalid JSON: ${stdout.slice(0, 300)}`)); }
      }
    );
  });
}
