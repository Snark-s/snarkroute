import { describe, expect, it } from "vitest";
import { codexLaunchSpec, decodePersonaImageUpload, summarizePersonaProcessError } from "../src/routes/persona-agent";

describe("Jabberwock image attachments", () => {
  it("decodes an allowed image data URL", () => {
    const result = decodePersonaImageUpload({
      name: "sample.png",
      mimeType: "image/png",
      dataBase64: "data:image/png;base64,aGVsbG8="
    });
    expect(result.extension).toBe(".png");
    expect(result.buffer.toString("utf8")).toBe("hello");
  });

  it("rejects unsupported attachment types", () => {
    expect(() => decodePersonaImageUpload({ mimeType: "image/svg+xml", dataBase64: "PHN2Zz4=" }))
      .toThrow(/Supported image types/);
  });
});

describe("Jabberwock Codex handoff", () => {
  it("opens a new Work task in Codex Desktop", () => {
    const executable = process.platform === "win32" ? process.execPath : undefined;
    const spec = codexLaunchSpec("C:\\work\\project", "Continue task task-1", "task-1", executable);
    const target = new URL(spec.args[0]);
    if (process.platform === "win32") expect(spec.command).toBe("explorer.exe");
    expect(target.protocol).toBe("codex:");
    expect(target.host).toBe("threads");
    expect(target.pathname).toBe("/new");
    expect(target.searchParams.get("path")).toBe("C:\\work\\project");
    expect(target.searchParams.get("prompt")).toBe("Continue task task-1");
    expect(target.searchParams.get("mode")).toBe("work");
  });

  it.runIf(process.platform === "win32")("fails visibly instead of handing a deep link to a stale Windows protocol registration", () => {
    expect(() => codexLaunchSpec("C:\\work\\project", "Continue", "task-1", "C:\\missing-codex.exe"))
      .toThrow(/current Codex Desktop executable was not found/);
  });
});

describe("Jabberwock process diagnostics", () => {
  it("shows the useful final Python error instead of a traceback", () => {
    const stderr = 'Traceback (most recent call last):\n  File "agent_task.py", line 1\nRuntimeError: Provider connection terminated.';
    expect(summarizePersonaProcessError(stderr, "", 1)).toBe("Provider connection terminated.");
  });
});
