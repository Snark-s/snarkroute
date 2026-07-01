import { useEffect, useState } from "react";
import { apiBase } from "../studioConfig";
import type { NodeRunResult } from "../studioTypes";

export function useImageDimensions(value: unknown): { dimensions: { width: number; height: number } | null; status: "idle" | "loading" | "ready" | "error" } {
  const directDimensions = imageDimensionsFromValue(value);
  const src = imagePreviewSrc(value);
  const [state, setState] = useState<{ src: string | null; dimensions: { width: number; height: number } | null; status: "idle" | "loading" | "ready" | "error" }>({
    src: null,
    dimensions: null,
    status: "idle"
  });

  useEffect(() => {
    if (directDimensions) {
      setState({ src: src ?? null, dimensions: directDimensions, status: "ready" });
      return;
    }
    if (!src) {
      setState({ src: null, dimensions: null, status: "idle" });
      return;
    }
    let cancelled = false;
    setState((current) => current.src === src && current.status === "ready" ? current : { src, dimensions: null, status: "loading" });
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      setState(width > 0 && height > 0 ? { src, dimensions: { width, height }, status: "ready" } : { src, dimensions: null, status: "error" });
    };
    image.onerror = () => {
      if (!cancelled) setState({ src, dimensions: null, status: "error" });
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, directDimensions?.width, directDimensions?.height]);

  if (directDimensions) return { dimensions: directDimensions, status: "ready" };
  return { dimensions: state.dimensions, status: state.status };
}

export function imageDimensionsFromValue(value: unknown): { width: number; height: number } | null {
  if (!value) return null;
  if (Array.isArray(value)) return imageDimensionsFromValue(value[0]);
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = imageDimensionsFromValue(record.image ?? record.output);
  if (nested) return nested;
  const width = Number(record.width);
  const height = Number(record.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : null;
}

export function isUnsetOrManifestDefaultResizeDimension(value: unknown): boolean {
  return value === undefined || value === null || value === "" || Number(value) === 1024;
}

export function imagePreviewSrc(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return imagePreviewSrc(value[0]);
  if (typeof value === "string") {
    if (/^data:image\//i.test(value)) return value;
    if (/^https?:\/\//i.test(value)) return value;
    if (/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(value)) return `${apiBase}/api/assets/preview?path=${encodeURIComponent(value)}`;
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const imageUrl = record.image_url && typeof record.image_url === "object" ? (record.image_url as Record<string, unknown>).url : undefined;
    const base64 = typeof record.b64_json === "string" ? `data:image/png;base64,${record.b64_json}` : undefined;
    const portableMimeType = typeof record.mimeType === "string" && record.mimeType.trim() ? record.mimeType.trim() : "image/png";
    const portableBase64 = typeof record.base64 === "string" ? `data:${portableMimeType};base64,${record.base64}` : undefined;
    return imagePreviewSrc(record.image ?? imageUrl ?? base64 ?? portableBase64 ?? record.localPath ?? record.path ?? record.originalUrl ?? record.url ?? record.output);
  }
  return null;
}

export function videoPreviewSrc(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return videoPreviewSrc(value[0]);
  if (typeof value === "string") {
    if (/^data:video\//i.test(value)) return value;
    if (/^https?:\/\//i.test(value)) return value;
    if (/\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(value)) return `${apiBase}/api/assets/preview?kind=video&path=${encodeURIComponent(value)}`;
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return videoPreviewSrc(record.video ?? record.localPath ?? record.path ?? record.originalUrl ?? record.url ?? record.output);
  }
  return null;
}

export function localImagePreviewSrc(path: string): string {
  return `${apiBase}/api/assets/preview?path=${encodeURIComponent(path)}`;
}

export function versionedAssetPreviewSrc(src: string | null, version: string): string | null {
  if (!src || !version || !src.includes("/api/assets/preview?")) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}_v=${encodeURIComponent(version)}`;
}

export function lastImageValue(value: unknown): unknown {
  const matches: unknown[] = [];
  collectImageValues(value, matches, new Set());
  return matches[matches.length - 1] ?? value;
}

export function collectImageValues(value: unknown, matches: unknown[], seen: Set<object>): void {
  if (!value) return;
  if (typeof value === "object") {
    if (seen.has(value)) return;
    seen.add(value);
  }
  if (imagePreviewSrc(value)) matches.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectImageValues(item, matches, seen);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectImageValues(item, matches, seen);
  }
}

export function liveFisheyeOutput(value: unknown): { source: unknown; fovDegrees: number; yawDegrees: number; pitchDegrees: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const valueRecord = value as Record<string, unknown>;
  if (valueRecord.image) {
    const nested = liveFisheyeOutput(valueRecord.image);
    if (nested) return nested;
  }
  const liveFisheye = valueRecord.liveFisheye;
  if (!liveFisheye || typeof liveFisheye !== "object" || Array.isArray(liveFisheye)) return null;
  const record = liveFisheye as Record<string, unknown>;
  if (!imagePreviewSrc(record.source)) return null;
  return {
    source: record.source,
    fovDegrees: numberParamValue(record.fovDegrees, 200),
    yawDegrees: numberParamValue(record.yawDegrees, 0),
    pitchDegrees: numberParamValue(record.pitchDegrees, -90)
  };
}

function numberParamValue(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : fallback;
  return Number.isFinite(number) ? number : fallback;
}

export function panoramaSourceSrc(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const panorama = record.panorama;
  if (!panorama || typeof panorama !== "object" || Array.isArray(panorama)) return null;
  const source = panorama as Record<string, unknown>;
  return imagePreviewSrc(source.sourceImage ?? source.sourceUrl ?? source.url ?? source.path);
}

export function imageLocalPath(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return imageLocalPath(value[0]);
  if (typeof value === "string") return /\.(png|jpg|jpeg|webp)$/i.test(value) && !/^https?:\/\//i.test(value) ? value : null;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return imageLocalPath(record.image ?? record.localPath ?? record.path ?? record.output);
  }
  return null;
}

export function imageLabel(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const image = ((record.image && typeof record.image === "object" ? record.image : record.video && typeof record.video === "object" ? record.video : record) as Record<string, unknown>);
    if (typeof record.image === "string" && /^data:image\//i.test(record.image)) return "generated image";
    if (typeof record.video === "string" && /^data:video\//i.test(record.video)) return "generated video";
    if (typeof image.base64 === "string") return String(image.filename ?? "generated image");
    return String(image.filename ?? image.localPath ?? image.path ?? image.originalUrl ?? "image");
  }
  if (typeof value === "string" && /^data:image\//i.test(value)) return "generated image";
  if (typeof value === "string" && /^data:video\//i.test(value)) return "generated video";
  return String(value ?? "image");
}

export function imageOutputIdForResult(result: NodeRunResult): string {
  if (result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
    const record = result.output as Record<string, unknown>;
    if (record.image) return "image";
    if (record.localPath || record.path || record.url || record.originalUrl) return "output";
  }
  return "image";
}

export function renderFisheyeFrame(canvas: HTMLCanvasElement, image: HTMLImageElement, view: { fovDegrees: number; yawDegrees: number; pitchDegrees: number }) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = image.naturalWidth;
  sourceCanvas.height = image.naturalHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) return;
  sourceContext.drawImage(image, 0, 0);

  const source = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const frame = context.createImageData(canvas.width, canvas.height);
  const sourceData = source.data;
  const frameData = frame.data;
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const radius = Math.min(canvas.width, canvas.height) / 2;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const maxTheta = (view.fovDegrees * Math.PI) / 360;
  const yaw = (view.yawDegrees * Math.PI) / 180;
  const pitch = (view.pitchDegrees * Math.PI) / 180;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  for (let y = 0; y < canvas.height; y += 1) {
    const normalizedY = ((y + 0.5) - centerY) / radius;
    for (let x = 0; x < canvas.width; x += 1) {
      const normalizedX = ((x + 0.5) - centerX) / radius;
      const distance = Math.hypot(normalizedX, normalizedY);
      const frameIndex = (y * canvas.width + x) * 4;
      if (distance > 1) {
        frameData[frameIndex + 3] = 0;
        continue;
      }
      const theta = distance * maxTheta;
      const phi = Math.atan2(normalizedY, normalizedX);
      const sinTheta = Math.sin(theta);
      const cameraX = sinTheta * Math.cos(phi);
      const cameraY = -sinTheta * Math.sin(phi);
      const cameraZ = Math.cos(theta);
      const pitchedY = cameraY * cosPitch - cameraZ * sinPitch;
      const pitchedZ = cameraY * sinPitch + cameraZ * cosPitch;
      const worldX = cameraX * cosYaw + pitchedZ * sinYaw;
      const worldY = pitchedY;
      const worldZ = -cameraX * sinYaw + pitchedZ * cosYaw;
      const longitude = Math.atan2(worldX, worldZ);
      const latitude = Math.asin(clamp(worldY, -1, 1));
      const sourceX = positiveModulo(Math.floor((longitude / (Math.PI * 2) + 0.5) * sourceWidth), sourceWidth);
      const sourceY = clamp(Math.floor((0.5 - latitude / Math.PI) * sourceHeight), 0, sourceHeight - 1);
      const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
      frameData[frameIndex] = sourceData[sourceIndex];
      frameData[frameIndex + 1] = sourceData[sourceIndex + 1];
      frameData[frameIndex + 2] = sourceData[sourceIndex + 2];
      frameData[frameIndex + 3] = sourceData[sourceIndex + 3];
    }
  }
  context.putImageData(frame, 0, 0);
}

export function panoramaSnapshotFilename(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, "") || "panorama";
  return `${base}-view.png`;
}

export function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

export function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

export function wrapDegrees(value: number): number {
  const wrapped = positiveModulo(value + 180, 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function roundCameraCoordinate(value: number): number {
  return Number(value.toFixed(2));
}

export function formatSliderValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(2)).toString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
