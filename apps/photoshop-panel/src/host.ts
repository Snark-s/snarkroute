import { createSelectionPlan, resultMaskPlan, type Bounds, type SelectionMode, type SelectionPlan } from "./selection";

const photoshop = require("photoshop"), { app, imaging, core } = photoshop;
type PhotoshopImageData = { width: number; height: number; components: number; componentSize: number; colorSpace: string; colorProfile: string; getData(options?: unknown): Promise<Uint8Array | Uint16Array | Float32Array>; dispose(): void };
export type SelectionCapture = { documentId: number; plan: SelectionPlan; compositeJpegBase64: string; mask: { dataBase64: string; componentSize: number; width: number; height: number; colorSpace: string; colorProfile: string }; maskImageData: PhotoshopImageData; documentColorProfile?: string; documentDepth?: number };
export type RawPixelResult = { dataBase64: string; width: number; height: number; components: 3 | 4; componentSize: 8 | 16 | 32; colorSpace: string; colorProfile: string; name?: string };

export class PhotoshopSelectionAdapter {
  async capture(mode: SelectionMode, contextPadding = 0.2): Promise<SelectionCapture> {
    const document = app.activeDocument;
    if (!document) throw new Error("Open a Photoshop document first.");
    let bounds: Bounds;
    try { bounds = plainBounds(document.selection.bounds); } catch { throw new Error("Make a pixel selection before running this tool."); }
    const plan = createSelectionPlan(bounds, { width: Number(document.width), height: Number(document.height) }, contextPadding, mode);
    const [composite, mask] = await Promise.all([
      imaging.getPixels({ documentID: document.id, sourceBounds: plan.contextBounds, componentSize: -1 }),
      imaging.getSelection({ documentID: document.id, sourceBounds: plan.selectionBounds })
    ]);
    try {
      const compositeJpegBase64 = await imaging.encodeImageData({ imageData: composite.imageData, base64: true });
      const maskBytes = await mask.imageData.getData({ chunky: false, fullRange: true });
      return { documentId: document.id, plan, compositeJpegBase64, mask: { dataBase64: bytesToBase64(new Uint8Array(maskBytes.buffer, maskBytes.byteOffset, maskBytes.byteLength)), componentSize: mask.imageData.componentSize, width: mask.imageData.width, height: mask.imageData.height, colorSpace: mask.imageData.colorSpace, colorProfile: mask.imageData.colorProfile }, maskImageData: mask.imageData, documentColorProfile: composite.imageData.colorProfile, documentDepth: composite.imageData.componentSize };
    } finally { composite.imageData.dispose(); }
  }

  async applyRawResult(result: RawPixelResult, capture: SelectionCapture): Promise<number> {
    const document = app.activeDocument;
    if (!document || document.id !== capture.documentId) throw new Error("The source Photoshop document is no longer active.");
    const bytes = base64ToBytes(result.dataBase64), typed = result.componentSize === 16 ? new Uint16Array(bytes.buffer) : result.componentSize === 32 ? new Float32Array(bytes.buffer) : bytes;
    const imageData = await imaging.createImageDataFromBuffer(typed, { width: result.width, height: result.height, components: result.components, colorSpace: result.colorSpace, colorProfile: result.colorProfile });
    try {
      let layerId = 0;
      await core.executeAsModal(async () => {
        const layer = await document.createLayer({ name: result.name ?? "SnarkRoute result" }); layerId = layer.id;
        await imaging.putPixels({ documentID: document.id, layerID: layer.id, imageData, replace: true, targetBounds: capture.plan.resultOrigin, commandName: "Place SnarkRoute result" });
        if (capture.plan.clipToSelection) { const maskPlan = resultMaskPlan(capture.plan); await imaging.putLayerMask({ documentID: document.id, layerID: layer.id, imageData: capture.maskImageData, replace: true, targetBounds: maskPlan.targetBounds, commandName: "Apply source selection mask" }); }
      }, { commandName: "SnarkRoute selection result" });
      return layerId;
    } finally { imageData.dispose(); capture.maskImageData.dispose(); }
  }
}

function plainBounds(value: any): Bounds { return { left: Number(value.left), top: Number(value.top), right: Number(value.right), bottom: Number(value.bottom) }; }
function bytesToBase64(bytes: Uint8Array) { let binary = ""; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); }
function base64ToBytes(value: string) { const binary = atob(value), bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index); return bytes; }
