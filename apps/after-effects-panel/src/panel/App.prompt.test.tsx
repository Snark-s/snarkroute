// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => cleanup());

describe("panel Prompt field", () => {
  it("shows a required Prompt for a Polza video model whose media contract omits text", async () => {
    const model = {
      id: "kling-video",
      storedModelId: "kling-video",
      providerModelId: "kling/v2.6",
      displayName: "Kling 2.6",
      provider: "polza",
      inputTypes: ["image"],
      outputTypes: ["video"],
      capabilities: ["video.generate"],
      roles: ["generator"],
      availability: { status: "available", configured: true },
      parameters: [],
      nodeType: "polza.video.generate"
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response('{"ok":true}', { status: 200 });
      if (url.includes("/api/models/executable-generation")) return new Response(JSON.stringify({ models: [model] }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`Unexpected URL: ${url}`);
    }));

    render(<App />);

    expect(await screen.findByRole("textbox", { name: "Prompt" })).toBeTruthy();
    expect(screen.getByText("Required for this model.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate" })).toHaveProperty("disabled", true);
  });
});
