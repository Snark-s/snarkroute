import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { codexCliCommand, codexCliEnv, CodexCliError, parseCodexRateLimits, type CodexCliOptions, type CodexRateLimitInfo } from "./codex-cli";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only the Codex bucket applies to Codex runs. Missing data stays unknown.
 * https://developers.openai.com/codex/app-server#6-rate-limits-chatgpt */
export function parseAppServerQuota(result: Record<string, unknown>, planType?: string): CodexRateLimitInfo | undefined {
  const buckets = object(result.rateLimitsByLimitId);
  const bucket = Object.keys(buckets).length ? object(buckets.codex) : object(result.rateLimits);
  const window = (raw: unknown) => {
    const value = object(raw);
    if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent) || value.usedPercent < 0) return undefined;
    return { used_percent: value.usedPercent, window_minutes: value.windowDurationMins, resets_at: value.resetsAt };
  };
  const primary = window(bucket.primary), secondary = window(bucket.secondary);
  if (!primary && !secondary) return undefined;
  return parseCodexRateLimits({ primary, secondary, plan_type: typeof bucket.planType === "string" ? bucket.planType : planType,
    rate_limit_reached_type: bucket.rateLimitReachedType, spend_control_reached: bucket.spendControlReached === true });
}

/** Official CLI RPC only: no thread, inference, login change, credit reset or
 * credential access. The CLI owns its authentication; PII is discarded. */
export async function readCodexQuota(options: CodexCliOptions & { timeoutMs?: number } = {}): Promise<CodexRateLimitInfo | undefined> {
  const command = options.command ?? await codexCliCommand(options.env);
  const child = (options.spawnImpl ?? spawn)(command, ["app-server", "--listen", "stdio://", "-c", 'forced_login_method="chatgpt"',
    "-c", 'model_provider="openai"', "-c", "mcp_servers={}", "-c", "features.hooks=false", "-c", "features.plugins=false"],
    { env: codexCliEnv(options.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  return new Promise((resolve, reject) => {
    let settled = false, planType: string | undefined, size = 0;
    const lines = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => finish(new CodexCliError("TIMEOUT", "Проверка квоты Codex не ответила вовремя."), undefined, true), options.timeoutMs ?? 10000);
    const finish = (error?: Error, result?: CodexRateLimitInfo, stop = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); lines.close(); child.stdin?.end();
      if (stop) child.kill();
      else { const cleanup = setTimeout(() => child.kill(), 2000); cleanup.unref(); child.once("close", () => clearTimeout(cleanup)); }
      if (error) reject(error); else resolve(result);
    };
    const send = (method: string, id?: number, params?: unknown) => child.stdin?.write(JSON.stringify({ method, ...(id === undefined ? {} : { id }), ...(params === undefined ? {} : { params }) }) + "\n");
    child.once("error", () => finish(new CodexCliError("CLI_ERROR", "Не удалось запустить проверку квоты Codex.")));
    child.once("close", () => finish(new CodexCliError("CLI_ERROR", "Codex завершился до получения квоты.")));
    child.stdin?.on("error", () => finish(new CodexCliError("CLI_ERROR", "Соединение проверки квоты Codex закрыто.")));
    child.stdout?.on("data", chunk => { size += Buffer.byteLength(chunk); if (size > 1024 * 1024) finish(new CodexCliError("CLI_ERROR", "Ответ проверки квоты слишком велик."), undefined, true); });
    child.stderr?.resume(); // Never expose CLI diagnostics or account fields to task/model logs.
    lines.on("line", line => {
      if (settled) return;
      let response: Record<string, unknown>;
      try { response = object(JSON.parse(line)); } catch { return; }
      if (![0, 1, 2].includes(response.id as number)) return;
      if (response.error) { finish(new CodexCliError("CLI_ERROR", "Codex не предоставил свежую квоту подписки.")); return; }
      if (response.id === 0) {
        send("initialized"); send("account/read", 1, { refreshToken: false });
      } else if (response.id === 1) {
        const account = object(object(response.result).account);
        if (account.type !== "chatgpt") { finish(new CodexCliError("NOT_SUBSCRIPTION", "Проверка квоты требует входа Codex через ChatGPT.")); return; }
        planType = typeof account.planType === "string" ? account.planType : undefined;
        send("account/rateLimits/read", 2);
      } else finish(undefined, parseAppServerQuota(object(response.result), planType));
    });
    send("initialize", 0, { clientInfo: { name: "snarkroute_quota", title: "SnarkRoute quota reader", version: "1.0.0" } });
  });
}
