import { SnarkRouteClient } from "./api";
import { PhotoshopSelectionAdapter } from "./host";
import type { SelectionMode } from "./selection";

const client = new SnarkRouteClient(), host = new PhotoshopSelectionAdapter();
const status = element<HTMLDivElement>("status"), tools = element<HTMLSelectElement>("tools"), run = element<HTMLButtonElement>("run");
element<HTMLButtonElement>("inspect").onclick = async () => { try { const capture = await host.capture(mode(), padding()); status.textContent = `Selection ${capture.plan.selectionBounds.left},${capture.plan.selectionBounds.top}–${capture.plan.selectionBounds.right},${capture.plan.selectionBounds.bottom}; context ${capture.plan.width}×${capture.plan.height}; exact mask captured.`; capture.maskImageData.dispose(); } catch (error) { showError(error); } };
element<HTMLButtonElement>("refresh").onclick = async () => { try { const catalog = await client.tools(); tools.replaceChildren(...catalog.tools.map(({ tool }) => { const option = document.createElement("option"); option.value = tool.id; option.textContent = tool.title; return option; })); run.disabled = catalog.tools.length === 0; status.textContent = `${catalog.tools.length} Photoshop tool(s) available.`; } catch (error) { showError(error); } };
run.onclick = () => { status.innerHTML = '<span class="error">Tool discovery and exact selection capture are active. Encoded-result decoding is intentionally blocked until the server returns the raw-pixel result contract required by putPixels.</span>'; };
function mode() { return element<HTMLSelectElement>("mode").value as SelectionMode; }
function padding() { return Number(element<HTMLInputElement>("padding").value); }
function element<T extends HTMLElement>(id: string) { const value = document.getElementById(id); if (!value) throw new Error(`Missing UI element ${id}.`); return value as T; }
function showError(error: unknown) { status.innerHTML = `<span class="error">${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
