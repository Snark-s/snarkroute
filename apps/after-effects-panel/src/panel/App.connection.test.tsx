// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.spyOn(console, "info").mockImplementation(() => undefined); vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => cleanup());

const image = { id: "image", storedModelId: "image", providerModelId: "image", displayName: "Flux Image", provider: "polza", inputTypes: ["text", "image"], outputTypes: ["image"], capabilities: ["image.generate"], roles: ["generator", "editor"], availability: { status: "available", configured: true }, parameters: [{ id: "prompt", type: "text" }], nodeType: "polza.image.generate" };
const video = { id: "video", storedModelId: "video", providerModelId: "video", displayName: "Seedance Video", provider: "polza", inputTypes: ["text", "image"], outputTypes: ["video"], capabilities: ["video.generate"], roles: ["generator"], availability: { status: "available", configured: true }, parameters: [{ id: "prompt", type: "text" }], nodeType: "polza.video.generate" };

describe("panel connection and operation flow", () => {
  it("auto-connects and reloads the executable generation catalog on reconnect", async () => { const fetchMock = mockCatalog([image, video]); render(<App />); await screen.findByText("SnarkRoute server: connected"); expect(calls(fetchMock, "/health")).toHaveLength(1); expect(calls(fetchMock, "/api/models/executable-generation")).toHaveLength(1); fireEvent.click(screen.getByRole("button", { name: "Reconnect" })); await waitFor(() => expect(calls(fetchMock, "/health")).toHaveLength(2)); });
  it("rebuilds models and inputs when operation changes", async () => { mockCatalog([image, video]); render(<App />); await screen.findByRole("option", { name: "Text to image" }); const operationSection = screen.getByText("Operation").parentElement!; fireEvent.change(operationSection.querySelector("select")!, { target: { value: "text-to-image" } }); expect(await screen.findByRole("option", { name: /Flux Image/ })).toBeTruthy(); expect(screen.queryByRole("option", { name: /Seedance Video/ })).toBeNull(); expect(screen.getByText("No media inputs are required.")).toBeTruthy(); });
  it("shows a read-only operation field when only one operation is executable", async () => { mockCatalog([{ ...image, inputTypes: ["text"] }]); render(<App />); expect(await screen.findByDisplayValue("Text to image")).toHaveProperty("readOnly", true); });
});

function mockCatalog(models: unknown[]) { const fetchMock = vi.fn(async (input: RequestInfo | URL) => { const url = String(input); if (url.endsWith("/health")) return new Response('{"ok":true}', { status: 200 }); if (url.includes("/api/models/executable-generation")) return new Response(JSON.stringify({ models }), { status: 200, headers: { "Content-Type": "application/json" } }); throw new Error(`Unexpected URL: ${url}`); }); vi.stubGlobal("fetch", fetchMock); return fetchMock; }
function calls(mock: { mock: { calls: ReadonlyArray<readonly unknown[]> } }, suffix: string) { return mock.mock.calls.filter(([input]) => String(input).includes(suffix)); }
