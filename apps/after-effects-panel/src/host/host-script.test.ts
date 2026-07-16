import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../../jsx/host.jsx", import.meta.url)), "utf8");

describe("After Effects host placeholder", () => {
  it("uses a SolidSource FootageItem and never imports an empty placeholder file", () => {
    expect(source).toContain("layers.addSolid(");
    expect(source).not.toContain("importPlaceholder(");
    expect(source).not.toMatch(/new File\([^)]*(empty|placeholder)/i);
  });

  it("replaces the existing FootageItem source without replacing the layer", () => {
    expect(source).toContain("footage.replace(new File(resultPath))");
    expect(source).not.toContain("layer.replaceSource(");
    expect(source).not.toContain("layer.remove(");
  });
});

describe("After Effects current frame export", () => {
  it("waits for a zero-byte file to become readable and stable twice", () => {
    const rendered = runRenderCurrentFrame([0, 24, 24]);
    expect(rendered.value).toMatchObject({ ok: true, size: 24, attempts: 3, waitedMs: 300, exportMethod: "saveFrameToPng", fallbackAttempted: false });
    expect(rendered.placeholderCreatedDuringExport).toBe(false);
  });

  it("resets stability when the file size changes", () => {
    const rendered = runRenderCurrentFrame([5, 8, 8]);
    expect(rendered.value).toMatchObject({ ok: true, size: 8, attempts: 3, waitedMs: 300 });
  });

  it("times out, reports diagnostics, and removes a zero-byte temporary file", () => {
    const rendered = runRenderCurrentFrame([0]);
    expect(rendered.value).toMatchObject({ ok: false, size: 0, waitedMs: 10000, fallbackAttempted: false, removedZeroByteFile: true });
    expect(rendered.value.fileError).toContain("Render Queue fallback is not enabled");
    expect(rendered.removed).toBe(true);
  });
});

function runRenderCurrentFrame(sizes: number[]) {
  let clock = 0;
  let sleepCount = 0;
  let saved = false;
  let removed = false;
  let placeholderCreatedDuringExport = false;
  class CompItem {
    id = 17; name = "Hero comp"; time = 2.5; width = 1920; height = 1080; frameRate = 25; duration = 30; pixelAspect = 1;
    layers = { addSolid: () => { placeholderCreatedDuringExport = true; } };
    saveFrameToPng() { saved = true; }
  }
  class MockFile {
    fsName: string; name: string; error = ""; encoding = ""; opened = false;
    constructor(path: string) { this.fsName = path; this.name = path.split(/[\\/]/).pop() ?? "frame.png"; }
    get exists() { return saved && !removed; }
    get length() { return this.exists ? sizes[Math.min(sleepCount, sizes.length - 1)] : 0; }
    open() { this.opened = this.exists && this.length > 0; return this.opened; }
    read() { return this.opened && this.length > 0 ? "x" : ""; }
    close() { this.opened = false; return true; }
    remove() { removed = true; return true; }
  }
  class MockFolder {
    static temp = { fsName: "C:\\Temp" }; static userData = { fsName: "C:\\User" };
    fsName: string; exists = true;
    constructor(path: string) { this.fsName = path; }
    create() { this.exists = true; return true; }
  }
  class MockDate { getTime() { return clock; } }
  const active = new CompItem();
  const context: Record<string, unknown> = {
    JSON, Math, Number, String, Boolean, Error,
    Date: MockDate, File: MockFile, Folder: MockFolder, CompItem,
    FolderItem: class {}, MarkerValue: class {},
    app: { project: { activeItem: active, numItems: 0 } },
    $: { sleep(ms: number) { clock += ms; sleepCount++; } }
  };
  runInNewContext(source, context);
  const host = context.SnarkRouteAE as { renderCurrentFrame(snapshot: object): string };
  const response = JSON.parse(host.renderCurrentFrame({ id: 17, time: 2.5 })) as { value: { ok: boolean; size: number; attempts: number; waitedMs: number; exportMethod: string; fallbackAttempted: boolean; removedZeroByteFile: boolean; fileError: string } };
  return { value: response.value, removed, placeholderCreatedDuringExport };
}
