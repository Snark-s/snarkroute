import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearServiceLogProvidersForTests,
  decodeLogBuffer,
  isErrorLine,
  listServiceLogs,
  readServiceLogChunk,
  redactLogText,
  registerServiceLogProvider,
  rotatedLogPath,
  trimLiveLog
} from "./service-logs";

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "service-logs-"));
  log = join(dir, "svc.log");
  clearServiceLogProvidersForTests();
  registerServiceLogProvider({ id: "svc", label: "Svc", sources: () => [{ id: "main", title: "main", path: log, owner: "managed" }] });
});

afterEach(() => {
  clearServiceLogProvidersForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("service log chunks", () => {
  it("starts on the tail, then streams only new whole lines", () => {
    writeFileSync(log, "one\ntwo\n");
    const first = readServiceLogChunk("svc", "main", undefined);
    expect(first.text).toBe("one\ntwo\n");
    appendFileSync(log, "three\npart");
    const next = readServiceLogChunk("svc", "main", first.cursor);
    expect(next.text).toBe("three\n");
    appendFileSync(log, "ial\n");
    expect(readServiceLogChunk("svc", "main", next.cursor).text).toBe("partial\n");
  });

  it("restarts from the beginning after the file was rotated", () => {
    writeFileSync(log, "old line that is long enough\n");
    const first = readServiceLogChunk("svc", "main", undefined);
    writeFileSync(log, "new\n");
    const after = readServiceLogChunk("svc", "main", first.cursor);
    expect(after.reset).toBe(true);
    expect(after.text).toBe("new\n");
  });

  it("reports a missing file as unavailable instead of failing", () => {
    expect(readServiceLogChunk("svc", "main", undefined)).toMatchObject({ available: false, text: "" });
    expect(() => readServiceLogChunk("nope", "main", undefined)).toThrow();
  });

  it("decodes Windows code pages and redacts secrets", () => {
    expect(decodeLogBuffer(Buffer.from([0xce, 0xf8, 0xe8, 0xe1, 0xea, 0xe0]))).toBe("Ошибка"); // windows-1251
    process.env.TEST_WORKER_TOKEN = "very-secret-value-123";
    const text = redactLogText("token very-secret-value-123 Bearer abcdefghijkl url?api_key=xyz123 hf_abcdefghijklmnopqrstu");
    expect(text).not.toMatch(/very-secret-value-123|abcdefghijkl|xyz123|hf_abc/);
    delete process.env.TEST_WORKER_TOKEN;
  });
});

describe("service log summaries", () => {
  it("marks the newest error line and changes the mark for a new error", () => {
    writeFileSync(log, "ready\nERROR: cuda out of memory\n");
    const [first] = listServiceLogs([{ id: "svc", label: "Svc", online: false }]);
    expect(first.sources[0].lastError).toMatch(/cuda out of memory/);
    appendFileSync(log, "Traceback (most recent call last):\n");
    const [second] = listServiceLogs([{ id: "svc", label: "Svc", online: false }]);
    expect(second.sources[0].errorMark).not.toBe(first.sources[0].errorMark);
  });

  it("does not flag benign lines as errors", () => {
    expect(isErrorLine("finished with 0 errors")).toBe(false);
    expect(isErrorLine("level=INFO msg=ok error=\"\"")).toBe(false);
    expect(isErrorLine("[warn] slow request")).toBe(false);
    expect(isErrorLine("Не удалось загрузить модель")).toBe(true);
  });

  it("lists registry runtimes without a log with an honest note", () => {
    const [entry] = listServiceLogs([{ id: "local-openai-127-0-0-1-9000", label: "Local 9000", online: true }]).filter(item => item.id !== "svc");
    expect(entry.logsAvailable).toBe(false);
    expect(entry.note).toMatch(/недоступен/);
  });
});

describe("live log rotation", () => {
  it("copies and truncates an oversized log, keeping a bounded history", () => {
    writeFileSync(log, "x".repeat(200));
    expect(trimLiveLog(log, 100, 2)).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("");
    expect(readFileSync(rotatedLogPath(log, 1), "utf8")).toHaveLength(200);
    writeFileSync(log, "y".repeat(200));
    trimLiveLog(log, 100, 2);
    writeFileSync(log, "z".repeat(200));
    trimLiveLog(log, 100, 2);
    expect(readFileSync(rotatedLogPath(log, 1), "utf8")[0]).toBe("z");
    expect(readFileSync(rotatedLogPath(log, 2), "utf8")[0]).toBe("y");
    expect(existsSync(rotatedLogPath(log, 3))).toBe(false);
  });
});

describe("log line levels", () => {
  it("trusts a line's own level over keywords", async () => {
    const { classifyLogLine } = await import("./service-logs");
    expect(classifyLogLine('level=INFO msg="waiting" status="llm server error"')).toBe("");
    expect(classifyLogLine("2026-10-17 02:15:27,591 INFO tove: acted → failed")).toBe("");
    expect(classifyLogLine('{"level":50,"msg":"boom"}')).toBe("error");
    expect(classifyLogLine("INFO:     Uvicorn running")).toBe("");
    expect(classifyLogLine("WARNING: low memory")).toBe("warn");
    expect(classifyLogLine("RuntimeError: CUDA out of memory")).toBe("error");
  });
});
