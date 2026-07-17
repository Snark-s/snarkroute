// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

beforeEach(() => {
  localStorage.clear();
  delete window.__adobe_cep__;
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

  it("shows every executable model returned by the endpoint", async () => {
    const model = { provider: "polza", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"], availability: { status: "available", configured: true }, parameters: [], nodeType: "polza.video.generate" };
    const models = [
      { ...model, id: "polza:bytedance/seedance-2", storedModelId: "bytedance/seedance-2", providerModelId: "bytedance/seedance-2", displayName: "Seedance 2", inputTypes: [], runnableWithSuppliedInputs: true, requiredImageInputs: 0, maximumImageInputs: 5 },
      { ...model, id: "polza:alibaba/happyhorse-1.0", storedModelId: "alibaba/happyhorse-1.0", providerModelId: "alibaba/happyhorse-1.0", displayName: "HappyHorse 1.0" }
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/health")
      ? new Response('{"ok":true}', { status: 200 })
      : new Response(JSON.stringify({ models, modelCount: 2, familyCount: 2, diagnosticsUrl: "/api/models/for-node/polza.video.generate/debug" }), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<App />);
    expect(await screen.findByRole("option", { name: /Seedance 2/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /HappyHorse 1.0/ })).toBeTruthy();
    expect(screen.getByText("Executable models: 2")).toBeTruthy();
    expect(screen.getByText("Families: 2")).toBeTruthy();
    expect(screen.getByText("Maximum images: 5")).toBeTruthy();
  });

  it("auto-selects a schema aspect ratio from the composition and lets the user change it", async () => {
    const model = {
      id: "polza:kling/v2.6", storedModelId: "kling/v2.6", providerModelId: "kling/v2.6", displayName: "Kling 2.6",
      provider: "polza", inputTypes: ["image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"],
      availability: { status: "available", configured: true }, nodeType: "polza.video.generate", runnableWithSuppliedInputs: true,
      parameters: [{ id: "aspect_ratio", label: "Aspect ratio", type: "select", required: true, options: ["1:1", "16:9", "9:16"].map((value) => ({ value })) }]
    };
    window.__adobe_cep__ = { evalScript(script, callback) {
      callback(script.includes("getActiveComposition")
        ? JSON.stringify({ ok: true, value: { id: 1, name: "HD", time: 0, width: 1920, height: 1080, frameRate: 25, duration: 5, pixelAspect: 1 } })
        : '{"ok":true,"value":null}');
    } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/health")
      ? new Response('{"ok":true}', { status: 200 })
      : new Response(JSON.stringify({ models: [model] }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(<App />);
    const aspectRatio = await screen.findByRole("combobox", { name: "Aspect ratio" }) as HTMLSelectElement;
    await waitFor(() => expect(aspectRatio.value).toBe("16:9"));
    fireEvent.change(aspectRatio, { target: { value: "9:16" } });
    expect(aspectRatio.value).toBe("9:16");
    fireEvent.change(screen.getByPlaceholderText("Describe the motion and scene"), { target: { value: "move" } });
    expect(screen.getByRole("button", { name: "Generate" }).hasAttribute("disabled")).toBe(false);

    fireEvent.change(aspectRatio, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Generate" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Aspect ratio is required")).toBeTruthy();
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

  it("shows late manifest diagnostics, recovery actions, commit and timestamp", async () => {
    localStorage.setItem("snarkroute.after-effects.active-job.v1", JSON.stringify({
      jobId: "job_manifest", serverUrl: "http://127.0.0.1:4317", outputPath: "C:\\Проект\\SnarkRoute Generations\\ready.mp4", createdAt: "now", status: "completed_with_warning", lastStage: "completed_with_warning", failedStage: "writing_manifest",
      modelId: "wan/2.5", provider: "polza", prompt: "move", params: {}, inputPaths: [], inputFramePath: "C:\\Temp\\frame.png", inputAssetId: "asset", sourceCompositionId: 1, sourceCompositionName: "Comp", sourceTime: 0, placeholderCreatedAt: "now", jobCreatedAt: "now",
      metadata: { manifestPath: "C:\\Проект\\SnarkRoute Generations\\ready.mp4.json" }, manifestDiagnostic: { ok: false }, failure: { failedStage: "writing_manifest", message: "Manifest write failed", technicalDetails: "Node error code: EACCES\nNode error message: access denied", outputPath: "C:\\Проект\\SnarkRoute Generations\\ready.mp4", manifestPath: "C:\\Проект\\SnarkRoute Generations\\ready.mp4.json", jobId: "job_manifest", providerJobId: "job_manifest", layerSourceReplaced: false }
    }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    render(<App />);
    expect(await screen.findByText("Stage: completed_with_warning")).toBeTruthy();
    expect(screen.queryByText("Stage: exporting_current_frame")).toBeNull();
    expect(screen.getByText("Manifest: C:\\Проект\\SnarkRoute Generations\\ready.mp4.json")).toBeTruthy();
    expect(screen.getByText(/Node error code: EACCES/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry manifest" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry import" })).toBeTruthy();
    expect(screen.getByText(/^Build: (?:[0-9a-f]+|commit unknown) · \d{4}-\d{2}-\d{2}T/)).toBeTruthy();
  });
});

function healthCalls(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
  return mock.mock.calls.filter(([input]) => String(input).endsWith("/health"));
}
