import { describe, expect, it } from "vitest";
import { codexThreadLaunchSpec } from "../src/services/codex-desktop";
import { decodePersonaImageUpload, personaRunArgs, summarizePersonaProcessError } from "../src/routes/persona-agent";

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
  it("opens a confirmed Codex thread instead of sending the prompt through a deep link", () => {
    const executable = process.platform === "win32" ? process.execPath : undefined;
    const spec = codexThreadLaunchSpec("0199f00d-1234-7000-8000-123456789abc", executable);
    const target = new URL(spec.target);
    if (process.platform === "win32") expect(spec.command).toBe("powershell.exe");
    expect(target.protocol).toBe("codex:");
    expect(target.host).toBe("threads");
    expect(target.pathname).toBe("/0199f00d-1234-7000-8000-123456789abc");
    expect(target.search).toBe("");
  });

  it.runIf(process.platform === "win32")("fails visibly instead of handing a deep link to a stale Windows protocol registration", () => {
    expect(() => codexThreadLaunchSpec("0199f00d-1234-7000-8000-123456789abc", "C:\\missing-codex.exe"))
      .toThrow(/current Codex Desktop executable was not found/);
  });
});

describe("Jabberwock process diagnostics", () => {
  it("shows the useful final Python error instead of a traceback", () => {
    const stderr = 'Traceback (most recent call last):\n  File "agent_task.py", line 1\nRuntimeError: Provider connection terminated.';
    expect(summarizePersonaProcessError(stderr, "", 1)).toBe("Provider connection terminated.");
  });
});

describe("Jabberwock model routing mode", () => {
  it("keeps the exact manual route when Auto is off", () => {
    const args = personaRunArgs("task-1", {
      model: "manual-model",
      executionProvider: "manual-provider",
      providerModelId: "provider/model",
      maxSteps: 12
    }, false);

    expect(args).toEqual([
      "agent_task.py", "run", "task-1",
      "--model", "manual-model",
      "--provider", "manual-provider",
      "--provider-model", "provider/model",
      "--max-steps", "12"
    ]);
  });

  it("adds Auto policy flags while preserving the manual route as fallback", () => {
    const args = personaRunArgs("task-1", {
      model: "manual-model",
      executionProvider: "manual-provider",
      providerModelId: "provider/model",
      autoMode: true,
      autoStrategy: "quality"
    }, true);

    expect(args).toContain("--auto-model");
    expect(args).toContain("quality");
    expect(args).toContain("manual-provider");
    expect(args).toContain("provider/model");
  });
});
