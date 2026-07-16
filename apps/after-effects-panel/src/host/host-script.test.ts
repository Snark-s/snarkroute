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

  it("imports FileSource footage and replaces the source of the existing layer", () => {
    expect(source).toContain("app.project.importFile(options)");
    expect(source).toContain("layer.replaceSource(imported, false)");
    expect(source).toContain("imported.mainSource instanceof FileSource");
    expect(source).not.toContain("footage.replace(new File(resultPath))");
    expect(source).not.toContain("layer.remove(");
  });

  it("organizes results, finds placeholders by job id, and removes only unused solids", () => {
    expect(source).toContain('projectFolder("SnarkRoute Generations")');
    expect(source).toContain("findPlaceholderLayer(reference)");
    expect(source).toContain("layerHasJobId(layer, reference.jobId)");
    expect(source).toContain("oldSource.usedIn.length === 0");
    expect(source).toContain("solidRetainedBecauseUsed");
  });

  it("imports real footage, preserves layer properties, replaces FileSource, and removes an unused solid", () => {
    const run = runResultImport(false);
    expect(run.imported).toMatchObject({ ok: true, importedItemType: "FootageItem", importedItemSourceType: "FileSource", projectFolderName: "SnarkRoute Generations" });
    expect(run.replaced).toMatchObject({ ok: true, sourceReplaced: true, newSourceType: "FileSource", solidRemoved: true });
    expect(run.layer.source.id).toBe(run.imported.importedItemId);
    expect(run.preservedAfter).toEqual(run.preservedBefore);
    expect(run.solidRemoved).toBe(true);
  });

  it("retains a placeholder solid that is still used by another layer", () => {
    const run = runResultImport(true);
    expect(run.replaced).toMatchObject({ ok: true, sourceReplaced: true, solidRetainedBecauseUsed: true });
    expect(run.solidRemoved).toBe(false);
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

function runResultImport(hasOtherSolidUse: boolean) {
  class FileSource { constructor(public file: MockFile) {} }
  class SolidSource {}
  class FolderItem { id = 33; name: string; selected = false; constructor(name: string) { this.name = name; } }
  class FootageItem {
    parentFolder?: FolderItem; selected = false; duration = 5; width = 1920; height = 1080; usedIn: unknown[] = []; removed = false;
    constructor(public id: number, public name: string, public mainSource: FileSource | SolidSource) {}
    remove() { this.removed = true; }
  }
  class MockFile {
    exists = true; length = 2048; error = ""; opened = false; name: string;
    constructor(public fsName: string) { this.name = fsName.split(/[\\/]/).pop() ?? "result.mp4"; }
    open() { this.opened = true; return true; } read() { return "x"; } close() { this.opened = false; }
  }
  class ImportOptions { importAs: unknown; constructor(public file: MockFile) {} canImportAs() { return true; } }
  const solid = new FootageItem(90, "Generating", new SolidSource());
  const layer = {
    index: 4, name: "Generating · Kling", comment: "SnarkRoute jobId=job_1; placeholder=true", source: solid,
    inPoint: 1, outPoint: 6, startTime: 1, stretch: 100, position: [960, 540], scale: [100, 100], rotation: 12, opacity: 80,
    effects: ["Glow"], masks: ["Mask 1"], blendMode: "ADD", parent: 7, markers: ["job_1"],
    property() { return { numKeys: 0 }; },
    replaceSource(item: FootageItem) { this.source = item; solid.usedIn = hasOtherSolidUse ? [{}] : []; }
  };
  solid.usedIn = [layer];
  class CompItem {
    id = 17; name = "Comp"; numLayers = 1;
    layer(index: number) { return index === 4 || index === 1 ? layer : null; }
  }
  const comp = new CompItem();
  const items: Array<CompItem | FootageItem | FolderItem> = [comp, solid];
  const project = {
    get numItems() { return items.length; },
    item(index: number) { return items[index - 1]; },
    selection: [],
    items: { addFolder(name: string) { const folder = new FolderItem(name); items.push(folder); return folder; } },
    importFile(options: ImportOptions) { const item = new FootageItem(120, options.file.name, new FileSource(options.file)); items.push(item); return item; }
  };
  const context: Record<string, unknown> = { JSON, Math, Number, String, Boolean, Error, File: MockFile, FileSource, SolidSource, FolderItem, FootageItem, CompItem, ImportOptions, ImportAsType: { FOOTAGE: "footage" }, MarkerValue: class {}, Folder: class {}, app: { project, beginUndoGroup() {}, endUndoGroup() {} } };
  runInNewContext(source, context);
  const api = context.SnarkRouteAE as { importResultFootage(path: string, name: string): string; replacePlaceholderSource(reference: object, importedItemId: number, name: string): string };
  const imported = JSON.parse(api.importResultFootage("C:\\result.mp4", "Kling 3.0 · date")).value;
  const preserved = () => ({ index: layer.index, inPoint: layer.inPoint, outPoint: layer.outPoint, startTime: layer.startTime, stretch: layer.stretch, position: layer.position, scale: layer.scale, rotation: layer.rotation, opacity: layer.opacity, effects: layer.effects, masks: layer.masks, blendMode: layer.blendMode, parent: layer.parent, markers: layer.markers });
  const preservedBefore = structuredClone(preserved());
  const replaced = JSON.parse(api.replacePlaceholderSource({ compositionId: 17, layerIndex: 4, footageItemId: 90, jobId: "job_1" }, imported.importedItemId, "Kling · Generated")).value;
  return { imported, replaced, layer, preservedBefore, preservedAfter: preserved(), solidRemoved: solid.removed };
}
