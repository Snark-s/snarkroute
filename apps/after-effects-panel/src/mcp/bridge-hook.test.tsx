// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAeMcpBridge } from "./bridge";

class MockWebSocket {
  static OPEN = 1;
  readonly url: string;
  readyState = 0;
  close = vi.fn();
  send = vi.fn();
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; instances.push(this); }
  message(value: object) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  closed(code = 1006, reason = "server restart") { this.onclose?.({ code, reason } as CloseEvent); }
}

const instances: MockWebSocket[] = [];

describe("useAeMcpBridge", () => {
  afterEach(() => { instances.length = 0; localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("automatically pairs on mount and only reports a session after registration", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const evalScript = vi.fn((_script: string, callback: (value: string) => void) => callback(JSON.stringify({ appVersion: "26", projectName: "Demo", projectPath: "C:\\demo.aep" })));
    Object.defineProperty(window, "__adobe_cep__", { configurable: true, value: { evalScript } });
    const fetchMock = mockPairingFetch(() => "pair-one");

    const { result, unmount } = renderHook(() => useAeMcpBridge("http://127.0.0.1:4317"));
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0].url).toContain("/api/ae-bridge?pairingToken=pair-one");
    expect(result.current.webSocketUrl).toBe("ws://127.0.0.1:4317/api/ae-bridge");
    expect(result.current.sessionStatus).toBe("not_registered");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4317/health", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4317/api/ae-bridge/pair", expect.objectContaining({ method: "POST" }));

    instances[0].readyState = MockWebSocket.OPEN;
    await act(async () => instances[0].message({ type: "authenticated" }));
    await waitFor(() => expect(instances[0].send).toHaveBeenCalledWith(expect.stringContaining('"type":"register"')));
    act(() => instances[0].message({ type: "registered", sessionId: result.current.sessionId }));
    await waitFor(() => expect(result.current).toMatchObject({ bridgeStatus: "connected", sessionStatus: "registered", pairingStatus: "paired" }));
    expect(localStorage.getItem("snarkroute.after-effects.bridge-token")).toBeNull();
    unmount();
  });

  it("gets a fresh one-time credential when reconnecting", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    Object.defineProperty(window, "__adobe_cep__", { configurable: true, value: { evalScript: vi.fn() } });
    let issued = 0; mockPairingFetch(() => `pair-${++issued}`);
    const { unmount } = renderHook(() => useAeMcpBridge("http://127.0.0.1:4317"));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(instances[0].url).toContain("pairingToken=pair-1");

    act(() => instances[0].closed());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(instances).toHaveLength(2);
    expect(instances[1].url).toContain("pairingToken=pair-2");
    unmount();
  });

  it("retries health and pairing after the server becomes available again", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    Object.defineProperty(window, "__adobe_cep__", { configurable: true, value: { evalScript: vi.fn() } });
    let healthCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/health")) return new Response("{}", { status: ++healthCalls === 1 ? 503 : 200 });
      return new Response(JSON.stringify({ pairingToken: `pair-${healthCalls}`, expiresInMs: 10_000 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const { unmount } = renderHook(() => useAeMcpBridge("http://127.0.0.1:4317"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toContain("pairingToken=pair-2");
    unmount();
  });

  it("leaves connecting and exposes a synchronous constructor error", async () => {
    vi.stubGlobal("WebSocket", class { static OPEN = 1; constructor() { throw new DOMException("Blocked by CSP", "SecurityError"); } });
    Object.defineProperty(window, "__adobe_cep__", { configurable: true, value: { evalScript: vi.fn() } });
    mockPairingFetch(() => "pair");

    const { result, unmount } = renderHook(() => useAeMcpBridge("http://127.0.0.1:4317"));

    await waitFor(() => expect(result.current.lastError).toContain("Blocked by CSP"));
    expect(result.current.bridgeStatus).toBe("disconnected");
    unmount();
  });
});

function mockPairingFetch(nextToken: () => string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/health")
    ? new Response('{"ok":true}', { status: 200 })
    : new Response(JSON.stringify({ pairingToken: nextToken(), expiresInMs: 10_000 }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
