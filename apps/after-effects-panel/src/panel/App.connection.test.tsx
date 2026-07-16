// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => cleanup());

describe("panel connection flow", () => {
  it("auto-connects through /health and Reconnect repeats the probe", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response('{"ok":true,"service":"snarkroute-server"}', { status: 200 });
      if (url.includes("/api/models/for-node/")) return new Response('{"models":[]}', { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("SnarkRoute server: connected");
    expect(healthCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByText("Status: 200")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(healthCalls(fetchMock)).toHaveLength(2));
  });

  it("shows the exact fetch error and requested URL", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("SnarkRoute server: disconnected");
    const diagnostics = within(screen.getByLabelText("Connection diagnostics"));
    expect(diagnostics.getByText("URL: http://127.0.0.1:4317/health")).toBeTruthy();
    expect(diagnostics.getByText("Error: TypeError: Failed to fetch")).toBeTruthy();
  });

  it("shows and opens the exact input frame recorded for the job", async () => {
    localStorage.setItem("snarkroute.after-effects.active-job.v1", JSON.stringify({
      jobId: "job_1", serverUrl: "http://127.0.0.1:4317", outputPath: "C:\\out.mp4", createdAt: "now", status: "completed",
      modelId: "wan/2.6", provider: "polza", prompt: "move", params: {}, inputPaths: ["C:\\server\\asset.png"],
      inputFramePath: "C:\\Temp\\sent-frame.png", inputAssetId: "asset_frame", sourceCompositionId: 17, sourceCompositionName: "Hero comp",
      sourceTime: 2.5, placeholderCreatedAt: null, jobCreatedAt: "job-time"
    }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const scripts: string[] = [];
    window.__adobe_cep__ = { evalScript(script, callback) { scripts.push(script); callback('{"ok":true,"value":null}'); } };

    render(<App />);
    expect(await screen.findByText("C:\\Temp\\sent-frame.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reveal input frame" }));
    fireEvent.click(screen.getByRole("button", { name: "Open input frame" }));
    await waitFor(() => expect(scripts).toHaveLength(2));
    expect(scripts[0]).toContain("revealFile");
    expect(scripts[1]).toContain("openFile");
    expect(scripts[1]).toContain("sent-frame.png");
  });
});

function healthCalls(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
  return mock.mock.calls.filter(([input]) => String(input).endsWith("/health"));
}
