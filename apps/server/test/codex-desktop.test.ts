import { describe, expect, it, vi } from "vitest";
import {
  codexThreadLaunchSpec,
  CodexDesktopTransferError,
  transferToCodexDesktop,
  type CodexRpcSession
} from "../src/services/codex-desktop";

const input = {
  taskId: "task-1",
  workspace: "C:\\work\\project",
  prompt: "Continue PersonaCore task task-1 from the saved handoff packet.",
  handoffPath: "C:\\persona\\tasks\\task-1\\artifacts\\handoffs\\codex.json"
};

describe("confirmed Codex Desktop transfer", () => {
  it("reports success only after thread/read sees the created turn", async () => {
    const calls: string[] = [];
    const retain = vi.fn();
    const close = vi.fn(async () => undefined);
    const session: CodexRpcSession = {
      async request(method) {
        calls.push(method);
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress" } };
        if (method === "thread/read") return { thread: { id: "thread-1", turns: [{ id: "turn-1" }] } };
        throw new Error(`Unexpected method ${method}`);
      },
      retainUntilTurnCompletes: retain,
      close
    };
    const openThread = vi.fn(async (threadId: string) => `codex://threads/${threadId}`);

    const result = await transferToCodexDesktop(input, {
      connect: async () => session,
      openThread,
      delay: async () => undefined,
      log: silentLog
    });

    expect(calls).toEqual(["thread/start", "turn/start", "thread/read"]);
    expect(retain).toHaveBeenCalledWith("thread-1", "turn-1");
    expect(openThread).toHaveBeenCalledWith("thread-1");
    expect(result).toMatchObject({ confirmed: true, threadId: "thread-1", turnId: "turn-1" });
    expect(close).not.toHaveBeenCalled();
  });

  it("does not report success when Codex never confirms the created turn", async () => {
    const close = vi.fn(async () => undefined);
    const session: CodexRpcSession = {
      async request(method) {
        if (method === "thread/start") return { thread: { id: "thread-2" } };
        if (method === "turn/start") return { turn: { id: "turn-2", status: "inProgress" } };
        if (method === "thread/read") return { thread: { id: "thread-2", turns: [] } };
        throw new Error(`Unexpected method ${method}`);
      },
      retainUntilTurnCompletes: vi.fn(),
      close
    };
    const openThread = vi.fn(async () => "codex://threads/thread-2");

    await expect(transferToCodexDesktop(input, {
      connect: async () => session,
      openThread,
      delay: async () => undefined,
      log: silentLog
    })).rejects.toMatchObject({
      name: "CodexDesktopTransferError",
      stage: "confirm",
      taskCreated: false
    });
    expect(openThread).not.toHaveBeenCalled();
  });

  it("preserves the confirmed thread id when Desktop navigation fails", async () => {
    const session: CodexRpcSession = {
      async request(method) {
        if (method === "thread/start") return { thread: { id: "thread-3" } };
        if (method === "turn/start") return { turn: { id: "turn-3", status: "inProgress" } };
        return { thread: { id: "thread-3", turns: [{ id: "turn-3" }] } };
      },
      retainUntilTurnCompletes: vi.fn(),
      close: vi.fn(async () => undefined)
    };

    try {
      await transferToCodexDesktop(input, {
        connect: async () => session,
        openThread: async () => { throw new Error("protocol handler rejected the URL"); },
        delay: async () => undefined,
        log: silentLog
      });
      throw new Error("Expected transfer to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexDesktopTransferError);
      expect(error).toMatchObject({ stage: "desktop-open", threadId: "thread-3", taskCreated: true });
      expect((error as Error).message).toMatch(/protocol handler rejected/);
    }
  });
});

describe("Codex Desktop thread navigation", () => {
  it("activates the registered codex URI handler through ShellExecute on Windows", () => {
    const spec = codexThreadLaunchSpec("thread 1", process.execPath, "win32");

    expect(spec.command).toBe("powershell.exe");
    expect(spec.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process -FilePath 'codex://threads/thread%201' -ErrorAction Stop"
    ]);
    expect(spec.target).toBe("codex://threads/thread%201");
  });

  it("fails before activation when the installed Desktop executable cannot be verified", () => {
    expect(() => codexThreadLaunchSpec("thread-1", "Z:\\missing\\Codex.exe", "win32"))
      .toThrow(/current Codex Desktop executable was not found/);
  });
});

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};
