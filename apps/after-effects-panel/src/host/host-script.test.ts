import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../../jsx/host.jsx", import.meta.url)), "utf8");

describe("After Effects host placeholder", () => {
  it("imports the submitted source image for the placeholder and keeps a solid fallback", () => {
    expect(source).toContain("importPlaceholderPreview(");
    expect(source).toContain("layers.add(preview)");
    expect(source).toContain("layers.addSolid(");
    expect(source).toContain('generationSubfolder("Placeholders")');
    expect(source).toMatch(/if \(!layer\).*layers\.addSolid/);
    expect(source).not.toMatch(/new File\([^)]*(empty|placeholder)/i);
  });

  it("uses layer comments for job lookup and never creates or reads timeline markers", () => {
    expect(source).toContain('"SnarkRoute job:" + jobId');
    expect(source).toContain("layerHasJobId(layer, reference.jobId)");
    expect(source).not.toContain("MarkerValue");
    expect(source).not.toContain('property("Marker")');
    expect(source).not.toContain("keyValue(");
  });

  it("creates a separate job-linked text overlay after the provider job exists", () => {
    expect(source).toContain("createGenerationOverlay(target, spec, duration, layer)");
    expect(source).toContain('target.layers.addText("Generating…")');
    expect(source).toContain('textLayer.property("Source Text")');
    expect(source).toContain("sourceRectAtTime(target.time, false)");
    expect(source).toContain('textLayer.name = "SnarkRoute · Generating text"');
    expect(source).toContain('background.name = "SnarkRoute · Generating background"');
    expect(source).toContain('jobComment(spec.jobId, spec.modelId, "overlay")');
    expect(source).toContain("ADBE Vector Fill Opacity");
  });

  it.each([[1920, 1080], [1080, 1920], [3840, 2160], [1024, 1024]])("keeps overlay geometry readable and inside safe margins for %ix%i", (width, height) => {
    const run = runPreviewPlaceholderReplacement(width, height);
    const diagnostics = run.reference.overlayDiagnostics;
    expect(diagnostics.fontSize).toBeCloseTo(Math.max(24, Math.min(72, height * 0.045)));
    expect(diagnostics.sourceRect.width).toBeGreaterThan(0);
    expect(diagnostics.sourceRect.height).toBeGreaterThan(0);
    expect(diagnostics.position[0]).toBeGreaterThanOrEqual(width * 0.04);
    expect(diagnostics.position[0] + diagnostics.sourceRect.width).toBeLessThanOrEqual(width * 0.96);
    expect(diagnostics.position[1] - diagnostics.sourceRect.height).toBeGreaterThanOrEqual(height * 0.04);
    expect(diagnostics.position[1]).toBeLessThanOrEqual(height * 0.96);
    expect(diagnostics.scale).toEqual([100, 100]);
    expect(diagnostics.opacity).toBe(100);
    expect(diagnostics.textLayerIndex).toBeLessThan(diagnostics.backgroundLayerIndex);
    expect(diagnostics.backgroundLayerIndex).toBeLessThan(diagnostics.placeholderLayerIndex);
    expect(run.overlayLayerNames).toEqual(["SnarkRoute · Generating text", "SnarkRoute · Generating background", "Generating · Kling 2.6"]);
    expect(run.overlayComments).toEqual([expect.stringContaining("job:job_preview"), expect.stringContaining("job:job_preview")]);
    expect(run.overlayStates).toEqual([
      { enabled: true, shy: false, guideLayer: false, parent: null, trackMatteType: "NONE" },
      { enabled: true, shy: false, guideLayer: false, parent: null, trackMatteType: "NONE" }
    ]);
    expect(run.remainingLayerNames).toEqual(["Generated"]);
  });

  it("treats empty sourceRectAtTime bounds as a non-fatal overlay warning", () => {
    const run = runPreviewPlaceholderReplacement(1920, 1080, true);
    expect(run.reference).toMatchObject({ overlayCreated: false, overlayError: expect.stringContaining("empty bounds") });
    expect(run.overlayLayerNames).toEqual(["Generating · Kling 2.6"]);
  });

  it("creates a job-linked preview layer and removes only its SnarkRoute temp source after replacement", () => {
    const run = runPreviewPlaceholderReplacement();
    expect(run.reference).toMatchObject({ jobId: "job_preview", previewPath: "C:\\Temp\\SnarkRoute AE\\frame.png", previewTemporary: true, placeholderKind: "source-preview" });
    expect(run.layer.comment).toContain("job:job_preview");
    expect(run.layer.inPoint).toBe(2.5);
    expect(run.reference).toMatchObject({ overlayCreated: true });
    expect(run.replaced).toMatchObject({ ok: true, sourceReplaced: true, temporaryPreviewRemoved: true, temporaryPreviewFileRemoved: true, overlayLayersRemoved: 2 });
    expect(run.remainingLayerNames).toEqual(["Generated"]);
    expect(run.removedPaths).toEqual(["C:\\Temp\\SnarkRoute AE\\frame.png"]);
  });

  it("imports FileSource footage and replaces the source of the existing layer", () => {
    expect(source).toContain("app.project.importFile(options)");
    expect(source).toContain("layer.replaceSource(imported, false)");
    expect(source).toContain("imported.mainSource instanceof FileSource");
    expect(source).not.toContain("footage.replace(new File(resultPath))");
  });

  it("organizes results, finds placeholders by job id, and removes only unused solids", () => {
    expect(source).toContain('projectFolder("SnarkRoute Generations")');
    expect(source).toContain("findPlaceholderLayer(reference)");
    expect(source).toContain("layerHasJobId(layer, reference.jobId)");
    expect(source).toContain("oldSource.usedIn.length === 0");
    expect(source).toContain("solidRetainedBecauseUsed");
    expect(source).toContain("temporaryPreviewRemoved");
    expect(source).toContain("previewTemporary");
  });

  it("imports real footage, preserves layer properties, replaces FileSource, and removes an unused solid", () => {
    const run = runResultImport(false);
    expect(run.imported).toMatchObject({ ok: true, importedItemType: "FootageItem", importedItemSourceType: "FileSource", projectFolderName: "SnarkRoute Generations/Videos" });
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

  it("reports project and fallback paths without writing manifests in ExtendScript", () => {
    expect(source).toContain("getProjectFileContext");
    expect(source).toContain("projectDirectory:");
    expect(source).toContain("appDataPath:");
    expect(source).toContain("tempPath:");
    expect(source).not.toContain("writeText");
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

function runPreviewPlaceholderReplacement(width = 1920, height = 1080, emptyBounds = false) {
  const removedPaths: string[] = [];
  class FileSource { constructor(public file: MockFile) {} }
  class SolidSource {}
  class FolderItem { static nextId = 200; id = FolderItem.nextId++; parentFolder?: FolderItem; constructor(public name: string) {} }
  class FootageItem {
    usedIn: unknown[] = []; removed = false; mainSource: FileSource | SolidSource; parentFolder?: FolderItem;
    constructor(public id: number, public name: string, source: FileSource | SolidSource) { this.mainSource = source; }
    remove() { this.removed = true; }
  }
  class MockFile {
    exists = true; length = 1024; error = ""; opened = false; name: string;
    constructor(public fsName: string) { this.name = fsName.split(/[\\/]/).pop() ?? "frame.png"; }
    open() { this.opened = true; return true; } read() { return "x"; } close() { this.opened = false; }
    remove() { removedPaths.push(this.fsName); this.exists = false; return true; }
  }
  class ImportOptions { importAs: unknown; constructor(public file: MockFile) {} canImportAs() { return true; } }
  let nextId = 90;
  const layers: Array<Record<string, any>> = [];
  const propertyState = (initial: any) => ({ value: initial, setValue(value: any) { this.value = value; } });
  const layer: Record<string, any> = {
    name: "", comment: "", source: null as FootageItem | null, startTime: 0, inPoint: 0, outPoint: 0,
    replaceSource(item: FootageItem) { const old = this.source; this.source = item; if (old) old.usedIn = []; }
  };
  Object.defineProperty(layer, "index", { get: () => layers.indexOf(layer) + 1 });
  function overlayLayer(kind: "shape" | "text", text = "") {
    const transformProperties: Record<string, any> = { "ADBE Anchor Point": propertyState([0, 0]), "ADBE Position": propertyState([0, 0]), "ADBE Scale": propertyState([100, 100]), "ADBE Opacity": propertyState(100) };
    const textDocument = { text, fontSize: 0, applyFill: false, fillColor: [0, 0, 0], applyStroke: true, justification: "" };
    const sourceText = { value: textDocument, setValue(value: any) { this.value = value; } };
    const overlay: Record<string, any> = { name: text, comment: "", startTime: 0, inPoint: 0, outPoint: 0, enabled: false, shy: true, guideLayer: true, parent: {}, trackMatteType: "ALPHA" };
    Object.defineProperty(overlay, "index", { get: () => layers.indexOf(overlay) + 1 });
    overlay.remove = () => { const index = layers.indexOf(overlay); if (index >= 0) layers.splice(index, 1); };
    overlay.moveBefore = (other: Record<string, any>) => { const ownIndex = layers.indexOf(overlay); if (ownIndex >= 0) layers.splice(ownIndex, 1); layers.splice(Math.max(0, layers.indexOf(other)), 0, overlay); };
    overlay.sourceRectAtTime = () => emptyBounds ? { left: 0, top: 0, width: 0, height: 0 } : { left: 3, top: -textDocument.fontSize * 0.82, width: textDocument.text.length * textDocument.fontSize * 0.56, height: textDocument.fontSize };
    overlay.property = (name: string) => {
      if (name === "Source Text") return sourceText;
      if (name === "ADBE Root Vectors Group") return { addProperty() { return { property() { return propertyState(null); } }; } };
      if (name === "ADBE Transform Group") return { property(propertyName: string) { return transformProperties[propertyName]; } };
      throw new Error(`Unexpected ${kind} property: ${name}`);
    };
    layers.unshift(overlay);
    return overlay;
  }
  class CompItem {
    id = 17; name = "Comp"; time = 2.5; width: number; height: number; frameRate = 25; duration = 30; pixelAspect = 1;
    constructor() { this.width = width; this.height = height; }
    get numLayers() { return layers.length; }
    layers = { add: (item: FootageItem) => { layer.source = item; item.usedIn = [layer]; layers.unshift(layer); return layer; }, addSolid: () => { throw new Error("solid fallback should not be used"); }, addShape: () => overlayLayer("shape"), addText: (text: string) => overlayLayer("text", text) };
    layer(index: number) { return layers[index - 1] ?? null; }
  }
  class MockFolder { static temp = { fsName: "C:\\Temp" }; static userData = { fsName: "C:\\User" }; constructor(public fsName: string) {} }
  const comp = new CompItem();
  const items: Array<CompItem | FootageItem | FolderItem> = [comp];
  const project = {
    activeItem: comp,
    get numItems() { return items.length; },
    item(index: number) { return items[index - 1]; },
    items: { addFolder(name: string) { const item = new FolderItem(name); items.push(item); return item; } },
    importFile(options: ImportOptions) { const item = new FootageItem(nextId++, options.file.name, new FileSource(options.file)); items.push(item); return item; }
  };
  const context: Record<string, unknown> = { JSON, Math, Number, String, Boolean, Error, File: MockFile, FileSource, SolidSource, FootageItem, CompItem, ImportOptions, ImportAsType: { FOOTAGE: "footage" }, ParagraphJustification: { LEFT_JUSTIFY: "LEFT" }, TrackMatteType: { NO_TRACK_MATTE: "NONE" }, Folder: MockFolder, FolderItem, app: { project, beginUndoGroup() {}, endUndoGroup() {} } };
  runInNewContext(source, context);
  const api = context.SnarkRouteAE as { createGenerationPlaceholder(spec: object): string; replacePlaceholderSource(reference: object, itemId: number, name: string): string };
  const reference = JSON.parse(api.createGenerationPlaceholder({ jobId: "job_preview", modelId: "kling/2.6", displayName: "Kling 2.6", name: "Generating · Kling 2.6", duration: 5, compositionId: 17, sourceTime: 2.5, width, height, frameRate: 25, pixelAspect: 1, previewPath: "C:\\Temp\\SnarkRoute AE\\frame.png", previewKind: "image", previewTemporary: true })).value;
  const overlayLayerNames = layers.map((value) => value.name);
  const overlayComments = layers.filter((value) => value !== layer).map((value) => value.comment);
  const overlayStates = layers.filter((value) => value !== layer).map((value) => ({ enabled: value.enabled, shy: value.shy, guideLayer: value.guideLayer, parent: value.parent, trackMatteType: value.trackMatteType }));
  const result = new FootageItem(120, "result.mp4", new FileSource(new MockFile("C:\\result.mp4"))); items.push(result);
  const replaced = JSON.parse(api.replacePlaceholderSource(reference, 120, "Generated")).value;
  return { reference, replaced, layer, removedPaths, overlayLayerNames, overlayComments, overlayStates, remainingLayerNames: layers.map((value) => value.name) };
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
    index: 4, name: "Generating · Kling", comment: "SnarkRoute job:job_1 model:kling/v3 role:placeholder", source: solid,
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
  const replaced = JSON.parse(api.replacePlaceholderSource({ compositionId: 17, layerIndex: 99, footageItemId: 90, jobId: "job_1" }, imported.importedItemId, "Kling · Generated")).value;
  return { imported, replaced, layer, preservedBefore, preservedAfter: preserved(), solidRemoved: solid.removed };
}
