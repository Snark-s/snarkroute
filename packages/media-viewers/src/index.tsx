import { useEffect, useRef, useState, type ReactNode } from "react";
import type * as Three from "three";

export interface CameraPose {
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number; roll: number };
  fov: number;
}

export interface SplatViewerRuntime {
  renderer: Three.WebGLRenderer;
  scene: Three.Scene;
  camera: Three.PerspectiveCamera;
  control: Three.Object3D;
}

export function SplatViewer({ splatUrl, initialCameraPose, className = "splatViewer", mountClassName = "splatViewerMount", canvasClassName = "splatViewerCanvas", onReady, onPoseChange, onStatusChange }: {
  splatUrl: string;
  initialCameraPose?: CameraPose;
  className?: string;
  mountClassName?: string;
  canvasClassName?: string;
  onReady?: (runtime: SplatViewerRuntime | null, mount: HTMLDivElement | null) => void;
  onPoseChange?: (pose: CameraPose) => void;
  onStatusChange?: (status: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SplatViewerRuntime | null>(null);
  const pose = initialCameraPose ?? { position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0, roll: 0 }, fov: 70 };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let renderer: Three.WebGLRenderer | null = null;
    let scene: Three.Scene | null = null;
    let splat: { dispose?: () => void } | null = null;
    let spark: Three.Object3D | null = null;
    let resizeObserver: ResizeObserver | null = null;
    onStatusChange?.("loading splat");

    void (async () => {
      const [THREE, sparkModule] = await Promise.all([import("three"), import("@sparkjsdev/spark")]);
      if (disposed) return;
      const { SparkControls, SparkRenderer, SplatMesh } = sparkModule;
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x090d14);
      const camera = new THREE.PerspectiveCamera(pose.fov || 70, 1, 0.01, 1000);
      const control = new THREE.Object3D();
      control.position.set(pose.position.x, pose.position.y, pose.position.z);
      control.rotation.set(toRadians(pose.rotation.pitch), toRadians(pose.rotation.yaw), toRadians(pose.rotation.roll), "YXZ");
      control.add(camera);
      scene.add(control);
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.className = canvasClassName;
      renderer.domElement.tabIndex = 0;
      mount.appendChild(renderer.domElement);
      spark = new SparkRenderer({ renderer });
      scene.add(spark as Three.Object3D);
      splat = new SplatMesh({
        url: splatUrl,
        onLoad: () => { if (!disposed) onStatusChange?.("splat ready"); },
        onProgress: (event: ProgressEvent) => { if (!disposed && event.lengthComputable && event.total > 0) onStatusChange?.(`loading splat ${Math.round((event.loaded / event.total) * 100)}%`); }
      });
      (splat as unknown as Three.Object3D).quaternion.set(1, 0, 0, 0);
      scene.add(splat as unknown as Three.Object3D);
      const controls = new SparkControls({ canvas: renderer.domElement });
      controls.fpsMovement.moveSpeed = 1.25;
      const resize = () => {
        if (!renderer) return;
        const rect = mount.getBoundingClientRect();
        camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
        camera.updateProjectionMatrix();
        renderer.setSize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)), false);
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
      resize();
      const euler = new THREE.Euler(0, 0, 0, "YXZ");
      renderer.setAnimationLoop(() => {
        if (!renderer || !scene) return;
        controls.update(control, camera);
        renderer.render(scene, camera);
        euler.setFromQuaternion(control.quaternion, "YXZ");
        onPoseChange?.({
          position: { x: round(control.position.x), y: round(control.position.y), z: round(control.position.z) },
          rotation: { yaw: wrapDegrees(toDegrees(euler.y)), pitch: clamp(toDegrees(euler.x), -89, 89), roll: toDegrees(euler.z) },
          fov: camera.fov
        });
      });
      runtimeRef.current = { renderer, scene, camera, control };
      onReady?.(runtimeRef.current, mount);
      renderer.domElement.focus();
    })().catch((error) => { if (!disposed) onStatusChange?.(error instanceof Error ? error.message : String(error)); });

    return () => {
      disposed = true;
      onReady?.(null, null);
      resizeObserver?.disconnect();
      renderer?.setAnimationLoop(null);
      if (scene && splat) scene.remove(splat as unknown as Three.Object3D);
      if (scene && spark) scene.remove(spark);
      runtimeRef.current = null;
      splat?.dispose?.();
      renderer?.dispose();
      renderer?.domElement.remove();
    };
  }, [splatUrl]);

  return <div className={className} onPointerEnter={() => runtimeRef.current?.renderer.domElement.focus()} onClick={() => runtimeRef.current?.renderer.domElement.focus()}><div ref={mountRef} className={mountClassName} /></div>;
}

export function Panorama360Viewer({ src, title = "360 panorama", className = "panoramaViewer", canvasClassName = "panoramaCanvas", width = 360, height = 190, initialFov = 55, children }: {
  src: string;
  title?: string;
  className?: string;
  canvasClassName?: string;
  width?: number;
  height?: number;
  initialFov?: number;
  children?: (state: { loaded: boolean; error: string; canvas: HTMLCanvasElement | null; view: { yaw: number; pitch: number; fov: number }; setFov: (fov: number) => void }) => ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const [view, setView] = useState({ yaw: 0, pitch: 0, fov: initialFov });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    setLoaded(false); setError("");
    image.onload = () => { imageRef.current = image; setLoaded(true); };
    image.onerror = () => setError("Could not load panorama image.");
    image.src = src;
  }, [src]);
  useEffect(() => { if (loaded && imageRef.current && canvasRef.current) renderPanoramaFrame(canvasRef.current, imageRef.current, view); }, [loaded, view]);
  return <div className={className}>
    <canvas ref={canvasRef} className={canvasClassName} width={width} height={height} title={title}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch }; }}
      onPointerMove={(event) => { const drag = dragRef.current; if (drag) setView((current) => ({ ...current, yaw: drag.yaw - (event.clientX - drag.x) * 0.006, pitch: clamp(drag.pitch + (event.clientY - drag.y) * 0.0045, -1.25, 1.25) })); }}
      onPointerUp={(event) => { dragRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragRef.current = null; }}
      onWheel={(event) => { event.preventDefault(); setView((current) => ({ ...current, fov: clamp(current.fov + Math.sign(event.deltaY) * 5, 35, 90) })); }} />
    {!loaded && !error ? <div className="panoramaOverlay">Loading panorama...</div> : null}
    {error ? <div className="panoramaOverlay error">{error}</div> : null}
    {children?.({ loaded, error, canvas: canvasRef.current, view, setFov: (fov) => setView((current) => ({ ...current, fov })) })}
  </div>;
}

export function renderPanoramaFrame(canvas: HTMLCanvasElement, image: HTMLImageElement, view: { yaw: number; pitch: number; fov: number }) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
  const sourceCanvas = document.createElement("canvas"); sourceCanvas.width = image.naturalWidth; sourceCanvas.height = image.naturalHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true }); if (!sourceContext) return;
  sourceContext.drawImage(image, 0, 0); const source = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height); const frame = context.createImageData(canvas.width, canvas.height);
  const fov = (view.fov * Math.PI) / 180; const tanV = Math.tan(fov / 2); const tanH = tanV * (canvas.width / canvas.height);
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
    const ny = (1 - ((y + 0.5) / canvas.height) * 2) * tanV; const nx = (((x + 0.5) / canvas.width) * 2 - 1) * tanH; const length = Math.hypot(nx, ny, 1);
    const cameraX = nx / length; const cameraY = ny / length; const cameraZ = 1 / length; const pitchedY = cameraY * Math.cos(view.pitch) - cameraZ * Math.sin(view.pitch); const pitchedZ = cameraY * Math.sin(view.pitch) + cameraZ * Math.cos(view.pitch);
    const worldX = cameraX * Math.cos(view.yaw) + pitchedZ * Math.sin(view.yaw); const worldZ = -cameraX * Math.sin(view.yaw) + pitchedZ * Math.cos(view.yaw);
    const sx = modulo(Math.floor((Math.atan2(worldX, worldZ) / (Math.PI * 2) + 0.5) * source.width), source.width); const sy = clamp(Math.floor((0.5 - Math.asin(clamp(pitchedY, -1, 1)) / Math.PI) * source.height), 0, source.height - 1);
    const si = (sy * source.width + sx) * 4; const fi = (y * canvas.width + x) * 4; frame.data[fi] = source.data[si]; frame.data[fi + 1] = source.data[si + 1]; frame.data[fi + 2] = source.data[si + 2]; frame.data[fi + 3] = 255;
  }
  context.putImageData(frame, 0, 0);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const modulo = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;
const toRadians = (value: number) => value * Math.PI / 180;
const toDegrees = (value: number) => value * 180 / Math.PI;
const round = (value: number) => Math.round(value * 1000) / 1000;
const wrapDegrees = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
