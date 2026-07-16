import type { CompositionSnapshot, GenerationMetadata, HostItemReference, RenderedAsset, ValidatedInputFile } from "../types";

declare global { interface Window { __adobe_cep__?: { evalScript(script: string, callback: (result: string) => void): void }; cep?: { fs: { readFile(path: string, encoding?: string): { err: number; data: string }; writeFile(path: string, data: string, encoding?: string): { err: number } } } } }

export interface AfterEffectsHostAdapter {
  getActiveComposition(): Promise<CompositionSnapshot | null>;
  renderCurrentFrame(snapshot: CompositionSnapshot): Promise<RenderedAsset>;
  validateInputFile(path: string): Promise<ValidatedInputFile>;
  createGenerationPlaceholder(spec: { name: string; duration: number; compositionId: number; sourceTime: number; width: number; height: number; frameRate: number; pixelAspect: number }): Promise<HostItemReference>;
  replacePlaceholderSource(reference: HostItemReference, resultPath: string): Promise<void>;
  writeGenerationMetadata(reference: HostItemReference, metadata: GenerationMetadata): Promise<void>;
  generationDirectory(): Promise<string>;
  revealFile(path: string): Promise<void>;
  openFile(path: string): Promise<void>;
}

export class CepAfterEffectsHostAdapter implements AfterEffectsHostAdapter {
  getActiveComposition() { return this.call<CompositionSnapshot | null>("getActiveComposition"); }
  renderCurrentFrame(snapshot: CompositionSnapshot) { return this.call<RenderedAsset>("renderCurrentFrame", snapshot); }
  validateInputFile(path: string) { return this.call<ValidatedInputFile>("validateInputFile", path); }
  createGenerationPlaceholder(spec: { name: string; duration: number; compositionId: number; sourceTime: number; width: number; height: number; frameRate: number; pixelAspect: number }) { return this.call<HostItemReference>("createGenerationPlaceholder", spec); }
  replacePlaceholderSource(reference: HostItemReference, resultPath: string) { return this.call<void>("replacePlaceholderSource", reference, resultPath); }
  writeGenerationMetadata(reference: HostItemReference, metadata: GenerationMetadata) { return this.call<void>("writeGenerationMetadata", reference, metadata); }
  generationDirectory() { return this.call<string>("generationDirectory"); }
  revealFile(path: string) { return this.call<void>("revealFile", path); }
  openFile(path: string) { return this.call<void>("openFile", path); }
  private call<T>(method: string, ...args: unknown[]): Promise<T> { return new Promise((resolve, reject) => { const cep = window.__adobe_cep__; if (!cep) return reject(new Error("Adobe CEP host is unavailable.")); const script = `SnarkRouteAE.${method}.apply(SnarkRouteAE, ${JSON.stringify(args)})`; cep.evalScript(script, (raw) => { try { const result = JSON.parse(raw) as { ok: boolean; value?: T; error?: string }; result.ok ? resolve(result.value as T) : reject(new Error(result.error ?? "After Effects host error.")); } catch { reject(new Error(raw || "Invalid response from After Effects.")); } }); }); }
}

export function readFileBase64(path: string): string { const result = window.cep?.fs.readFile(path, "Base64"); if (!result || result.err) throw new Error(`Could not read rendered frame (${result?.err ?? "CEP unavailable"}).`); return result.data; }
export function writeBinaryBase64(path: string, bytes: ArrayBuffer): void { const binary = Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join(""); const base64 = btoa(binary); const result = window.cep?.fs.writeFile(path, base64, "Base64"); if (!result || result.err) throw new Error(`Could not write generated video (${result?.err ?? "CEP unavailable"}).`); }
export function writeText(path: string, text: string): void { const result = window.cep?.fs.writeFile(path, text, "UTF8"); if (!result || result.err) throw new Error(`Could not write manifest (${result?.err ?? "CEP unavailable"}).`); }
