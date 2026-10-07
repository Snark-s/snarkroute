// IPC-owned subprocess helper. Parent disconnect is an event, not a polling loop.
import { execFile, spawn } from "node:child_process";

let child;
let stopping;
let reason;
let timer;
let output = "";
let stdout = "", stderr = "", startedAt = 0;
const maxOutput = 32_000;
function stop(message) {
  if (stopping) return stopping;
  reason = message;
  stopping = new Promise((resolve, reject) => {
    if (!child?.pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, error => {
        if (error && child.exitCode === null) reject(error); else resolve();
      });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); resolve(); }
      catch (error) { if (error.code === "ESRCH") resolve(); else reject(error); }
    }
  });
  void stopping.catch(error => finish({ success: false, error: `Process-tree termination failed: ${error.message}`, output }));
  return stopping;
}
function finish(result) {
  clearTimeout(timer);
  if (process.connected) process.send({ ...result, durationMs: Date.now() - startedAt,
    stdoutSummary: stdout, stderrSummary: stderr }, () => process.disconnect());
}
process.on("message", message => {
  if (message?.type === "cancel") { void stop("Package script aborted."); return; }
  if (child || message?.type !== "run") return;
  startedAt = Date.now();
  child = spawn(message.command, message.argv, { cwd: message.cwd, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const append = data => { if (output.length < maxOutput) output = (output + data.toString()).slice(0, maxOutput); };
  child.stdout.on("data", data => { append(data); stdout = (stdout + data.toString()).slice(-8000); });
  child.stderr.on("data", data => { append(data); stderr = (stderr + data.toString()).slice(-8000); });
  timer = setTimeout(() => { void stop("Package script timed out after 120000 ms."); }, 120_000);
  timer.unref();
  child.once("error", error => finish({ success: false, error: error.message, output }));
  child.once("close", async code => {
    try {
      await stopping;
      finish({ success: code === 0 && !reason, output,
        ...(code !== null ? { exitCode: code } : {}),
        ...(reason ? { error: reason } : code !== 0 ? { error: `Package script exited with code ${code}.` } : {}) });
    } catch (error) { finish({ success: false, error: `Process-tree termination failed: ${error.message}`, output }); }
  });
});
process.on("disconnect", () => { if (child?.exitCode === null) void stop("Supervisor disconnected."); });
process.on("SIGTERM", () => { void stop("Package worker terminated."); });
process.on("SIGINT", () => { void stop("Package worker interrupted."); });
