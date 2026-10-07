import { describe, expect, it } from "vitest";
import { ApiRequestError, codexRetryFromError, confirmedCodexNotice } from "./codexHandoff";

describe("Codex handoff UI state", () => {
  it("shows success only for a confirmed thread", () => {
    expect(confirmedCodexNotice({
      ok: true,
      confirmed: true,
      threadId: "thread-1",
      handoffPath: "C:\\persona\\handoff.json"
    })).toContain("thread-1");
  });

  it("keeps the saved handoff and confirmed thread for a retry", () => {
    const error = new ApiRequestError(502, {
      error: "Codex Desktop could not open the confirmed task.",
      retryable: true,
      contextPreserved: true,
      handoffPath: "C:\\persona\\handoff.json",
      taskCreated: true,
      threadId: "thread-2"
    });

    expect(codexRetryFromError(error, "task-1", "C:\\work\\project")).toEqual({
      taskId: "task-1",
      workspace: "C:\\work\\project",
      handoffPath: "C:\\persona\\handoff.json",
      existingThreadId: "thread-2"
    });
  });
});
