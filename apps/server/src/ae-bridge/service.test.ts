import { describe, expect, it, vi } from "vitest";
import { AeBridgeService, type AeSocket } from "./service";

class MockSocket implements AeSocket {
  sent: Array<Record<string, unknown>> = [];
  onSend?: (message: Record<string, unknown>) => void;
  send(data: string) { const message = JSON.parse(data) as Record<string, unknown>; this.sent.push(message); this.onSend?.(message); }
}
const registration = (id: string) => ({ type: "register" as const, sessionId: id, host: "aftereffects" as const, appVersion: "26.0", extensionVersion: "0.1.0", projectName: `Project ${id}`, projectPath: `C:\\${id}.aep` });

describe("AeBridgeService", () => {
  it("registers, selects the only session, and removes it on disconnect", () => {
    const bridge = new AeBridgeService(); const socket = new MockSocket();
    bridge.handleMessage(socket, registration("one"));
    expect(bridge.resolveSession().sessionId).toBe("one");
    expect(bridge.listSessions()[0]).toMatchObject({ appVersion: "26.0", projectName: "Project one" });
    bridge.disconnect(socket);
    expect(() => bridge.resolveSession()).toThrow(/No After Effects session/);
  });

  it("requires sessionId when multiple sessions are active", () => {
    const bridge = new AeBridgeService();
    bridge.handleMessage(new MockSocket(), registration("one")); bridge.handleMessage(new MockSocket(), registration("two"));
    expect(() => bridge.resolveSession()).toThrow(/one.*two/);
  });

  it("expires stale heartbeats", () => {
    const bridge = new AeBridgeService(10); const socket = new MockSocket(); bridge.handleMessage(socket, registration("old"));
    bridge.expireStaleSessions(Date.now() + 20);
    expect(bridge.listSessions()).toEqual([]);
  });

  it("serializes commands per session and preserves unicode", async () => {
    const bridge = new AeBridgeService(); const socket = new MockSocket(); bridge.handleMessage(socket, registration("one"));
    let inFlight = 0; let peak = 0;
    socket.onSend = (message) => { if (message.type !== "execute-jsx") return; inFlight++; peak = Math.max(peak, inFlight); setTimeout(() => { inFlight--; bridge.handleMessage(socket, { type: "execute-jsx-result", requestId: message.requestId, ok: true, result: message.code, logs: [], durationMs: 1 }); }, 5); };
    const [first, second] = await Promise.all([bridge.execute(undefined, { code: "Привет\nмир" }), bridge.execute(undefined, { code: "второй" })]);
    expect(peak).toBe(1); expect(first.result).toBe("Привет\nмир"); expect(second.result).toBe("второй");
  });

  it("times out and ignores a late response", async () => {
    vi.useFakeTimers();
    const bridge = new AeBridgeService(); const socket = new MockSocket(); bridge.handleMessage(socket, registration("one"));
    const promise = bridge.execute(undefined, { code: "slow", timeoutMs: 1_000 });
    await Promise.resolve();
    const requestId = String(socket.sent.at(-1)?.requestId);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(promise).resolves.toMatchObject({ ok: false, requestId, error: { message: expect.stringMatching(/timed out/) } });
    const next = bridge.execute(undefined, { code: "next" });
    await Promise.resolve();
    expect(socket.sent.filter((message) => message.type === "execute-jsx")).toHaveLength(1);
    expect(() => bridge.handleMessage(socket, { type: "execute-jsx-result", requestId, ok: true, result: "late", logs: [], durationMs: 2_000 })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.filter((message) => message.type === "execute-jsx")).toHaveLength(2);
    const nextId = socket.sent.at(-1)?.requestId;
    bridge.handleMessage(socket, { type: "execute-jsx-result", requestId: nextId, ok: true, result: "next", logs: [], durationMs: 1 });
    await expect(next).resolves.toMatchObject({ result: "next" });
    vi.useRealTimers();
  });

  it("returns structured ExtendScript errors", async () => {
    const bridge = new AeBridgeService(); const socket = new MockSocket(); bridge.handleMessage(socket, registration("one"));
    socket.onSend = (message) => { if (message.type === "execute-jsx") bridge.handleMessage(socket, { type: "execute-jsx-result", requestId: message.requestId, ok: false, error: { message: "boom", line: 12, fileName: "test.jsx", stack: "stack" }, logs: [{ level: "error", message: "boom" }], durationMs: 4 }); };
    await expect(bridge.execute(undefined, { code: "throw" })).resolves.toMatchObject({ ok: false, error: { message: "boom", line: 12 }, durationMs: 4 });
  });
});
