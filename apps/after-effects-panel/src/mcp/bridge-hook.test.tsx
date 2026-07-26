// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
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
}

const instances: MockWebSocket[] = [];

describe("useAeMcpBridge", () => {
  afterEach(() => { instances.length = 0; vi.restoreAllMocks(); });

  it("closes the old socket and reconnects immediately when the token changes", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    Object.defineProperty(window, "__adobe_cep__", { configurable: true, value: { evalScript: vi.fn() } });
    const { rerender, unmount } = renderHook(({ token }) => useAeMcpBridge("http://127.0.0.1:4317", token), { initialProps: { token: "first" } });
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe("ws://127.0.0.1:4317/api/ae-bridge");

    rerender({ token: "second" });

    expect(instances[0].close).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(2);
    unmount();
  });

  it("leaves connecting and exposes a synchronous constructor error", () => {
    vi.stubGlobal("WebSocket", class { static OPEN = 1; constructor() { throw new DOMException("Blocked by CSP", "SecurityError"); } });
    Object.defineProperty(window, "__adobe_cep__", { configurable: true, value: { evalScript: vi.fn() } });

    const { result, unmount } = renderHook(() => useAeMcpBridge("http://127.0.0.1:4317", "token"));

    expect(result.current.status).toBe("offline");
    expect(result.current.lastError).toContain("Blocked by CSP");
    unmount();
  });
});
