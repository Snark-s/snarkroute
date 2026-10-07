export type CameraVector3 = { x: number; y: number; z: number };
export type CameraOrientation = { yaw: number; pitch: number; roll?: number };
export type CameraOrbit = { azimuth: number; elevation: number; distance: number };
export type CameraLens = { focalLengthMm?: number; fieldOfViewDegrees?: number };
export type CameraSubjectBox = { x: number; y: number; width: number; height: number };

export type CameraKeyframe = {
  time: number;
  orbit?: Partial<CameraOrbit>;
  position?: CameraVector3;
  target?: CameraVector3;
  orientation?: CameraOrientation;
  lens?: CameraLens;
  /** Backward-compatible shorthand understood by the hosted H3 Max adapter. */
  azimuth?: number;
  elevation?: number;
  distance?: number;
};

export type CameraPath = {
  schemaVersion?: "1.0";
  keyframes: CameraKeyframe[];
  interpolation?: "linear" | "smooth";
  loopClosure?: "auto" | "off";
  startHold?: number;
  endHold?: number;
  subjectBox?: CameraSubjectBox;
};

export type NormalizedCameraKeyframe = CameraKeyframe & { orbit: CameraOrbit };
export type NormalizedCameraPath = Omit<CameraPath, "schemaVersion" | "keyframes" | "interpolation" | "loopClosure" | "startHold" | "endHold"> & {
  schemaVersion: "1.0";
  keyframes: NormalizedCameraKeyframe[];
  interpolation: "linear" | "smooth";
  loopClosure: "auto" | "off";
  startHold: number;
  endHold: number;
};

export type H3MaxCameraPose = { time: number; azimuth: number; elevation: number; distance: number };

const EPSILON = 1e-7;

export function normalizeCameraPath(path: CameraPath): NormalizedCameraPath {
  if (!path || !Array.isArray(path.keyframes) || path.keyframes.length === 0) throw new Error("CameraPath requires at least one keyframe.");
  if (path.schemaVersion !== undefined && path.schemaVersion !== "1.0") throw new Error(`Unsupported CameraPath schema version: ${path.schemaVersion}.`);
  const sorted = path.keyframes.map((keyframe, index) => normalizeKeyframe(keyframe, index)).sort((a, b) => a.time - b.time);
  for (let index = 1; index < sorted.length; index++) {
    if (Math.abs(sorted[index]!.time - sorted[index - 1]!.time) < EPSILON) throw new Error("CameraPath keyframe times must be unique.");
  }
  const startHold = unitInterval(path.startHold ?? 0, "CameraPath startHold");
  const endHold = unitInterval(path.endHold ?? 0, "CameraPath endHold");
  if (startHold + endHold >= 1) throw new Error("CameraPath startHold and endHold must leave time for camera motion.");
  if (path.subjectBox) validateSubjectBox(path.subjectBox);
  return {
    ...path,
    schemaVersion: "1.0",
    keyframes: unwrapCameraPathAngles(sorted),
    interpolation: path.interpolation ?? "smooth",
    loopClosure: path.loopClosure ?? "off",
    startHold,
    endHold
  };
}

export function unwrapCameraPathAngles(keyframes: NormalizedCameraKeyframe[]): NormalizedCameraKeyframe[] {
  const result: NormalizedCameraKeyframe[] = [];
  for (const keyframe of keyframes) {
    const copy = { ...keyframe, orbit: { ...keyframe.orbit } };
    const previous = result.at(-1);
    if (previous) copy.orbit.azimuth = unwrapAngle(previous.orbit.azimuth, copy.orbit.azimuth);
    result.push(copy);
  }
  return result;
}

export function sampleCameraPath(path: CameraPath, time: number): H3MaxCameraPose {
  const normalized = normalizeCameraPath(path);
  const t = unitInterval(time, "CameraPath sample time");
  const motionTime = remapHoldTime(t, normalized.startHold, normalized.endHold);
  const frames = normalized.keyframes;
  if (frames.length === 1 || motionTime <= frames[0]!.time) return pose(frames[0]!, t);
  if (motionTime >= frames.at(-1)!.time) return pose(frames.at(-1)!, t);
  const rightIndex = frames.findIndex((frame) => frame.time >= motionTime);
  const leftIndex = Math.max(0, rightIndex - 1), left = frames[leftIndex]!, right = frames[rightIndex]!;
  const span = right.time - left.time, amount = span <= EPSILON ? 0 : (motionTime - left.time) / span;
  const value = (key: keyof CameraOrbit) => normalized.interpolation === "linear"
    ? lerp(left.orbit[key], right.orbit[key], amount)
    : monotoneCubic(frames.map((frame) => frame.time), frames.map((frame) => frame.orbit[key]), leftIndex, motionTime);
  return { time: t, azimuth: value("azimuth"), elevation: value("elevation"), distance: value("distance") };
}

export function cameraPathForH3Max(path: CameraPath): { camera_trajectory: H3MaxCameraPose[]; warnings: string[] } {
  const normalized = normalizeCameraPath(path), warnings: string[] = [];
  if (normalized.keyframes.some((frame) => frame.position || frame.target || frame.orientation || frame.lens)) warnings.push("H3 Max native camera controls currently accept orbit parameters only; position, target, orientation, and lens fields remain in the portable CameraPath but are omitted from this request.");
  if (normalized.subjectBox) warnings.push("H3 Max does not expose subject_box in the native camera-controls schema; it remains available to prompt and future 6DoF adapters.");
  const motionSpan = 1 - normalized.startHold - normalized.endHold;
  const camera_trajectory = normalized.keyframes.map((frame) => ({ time: roundProviderNumber(normalized.startHold + frame.time * motionSpan), ...frame.orbit }));
  return { camera_trajectory, warnings };
}

export function compileCameraPathPrompt(path: CameraPath): string {
  const normalized = normalizeCameraPath(path), first = normalized.keyframes[0]!, last = normalized.keyframes.at(-1)!;
  if (normalized.keyframes.length === 1 || cameraMotionMagnitude(first.orbit, last.orbit) < EPSILON) return "Locked-off static camera; preserve framing and subject position.";
  const parts: string[] = [];
  const azimuthDelta = last.orbit.azimuth - first.orbit.azimuth;
  const elevationDelta = last.orbit.elevation - first.orbit.elevation;
  const distanceDelta = last.orbit.distance - first.orbit.distance;
  if (Math.abs(azimuthDelta) >= 359) parts.push(`${azimuthDelta > 0 ? "clockwise" : "counter-clockwise"} ${Math.abs(azimuthDelta).toFixed(0)}-degree orbit`);
  else if (Math.abs(azimuthDelta) >= 2) parts.push(`${azimuthDelta > 0 ? "orbit right" : "orbit left"} by ${Math.abs(azimuthDelta).toFixed(0)} degrees`);
  if (Math.abs(elevationDelta) >= 2) parts.push(`${elevationDelta > 0 ? "crane upward" : "crane downward"} by ${Math.abs(elevationDelta).toFixed(0)} degrees`);
  if (Math.abs(distanceDelta) >= 0.02) parts.push(`${distanceDelta < 0 ? "dolly in" : "dolly out"} smoothly`);
  const hold = [normalized.startHold > 0 ? `hold opening framing for ${percent(normalized.startHold)}` : "", normalized.endHold > 0 ? `hold final framing for ${percent(normalized.endHold)}` : ""].filter(Boolean).join(", then ");
  return `Camera direction: ${parts.join(", then ") || "smooth controlled camera movement"}${hold ? `; ${hold}` : ""}. Keep the subject stable and avoid sudden reframing.${isCameraLoopClosed(normalized) ? " End on the opening camera pose for a seamless loop." : ""}`;
}

export function isCameraLoopClosed(path: CameraPath | NormalizedCameraPath): boolean {
  const normalized = path.schemaVersion === "1.0" && path.interpolation && path.loopClosure && path.startHold !== undefined
    ? path as NormalizedCameraPath
    : normalizeCameraPath(path);
  if (normalized.loopClosure === "off") return false;
  const first = normalized.keyframes[0]!, last = normalized.keyframes.at(-1)!;
  return Math.abs(shortAngleDelta(first.orbit.azimuth, last.orbit.azimuth)) < 0.5
    && Math.abs(first.orbit.elevation - last.orbit.elevation) < 0.5
    && Math.abs(first.orbit.distance - last.orbit.distance) < 0.01;
}

export const H3_CAMERA_PRESETS = {
  static: (): CameraPath => ({ schemaVersion: "1.0", keyframes: [{ time: 0, orbit: { azimuth: 0, elevation: 0, distance: 1 } }], interpolation: "linear" }),
  orbitLeft: (): CameraPath => twoPointPath(25, -25, 0, 0, 1, 1),
  orbitRight: (): CameraPath => twoPointPath(-25, 25, 0, 0, 1, 1),
  orbit360: (): CameraPath => ({ schemaVersion: "1.0", keyframes: [{ time: 0, orbit: { azimuth: 0, elevation: 0, distance: 1 } }, { time: 1, orbit: { azimuth: 360, elevation: 0, distance: 1 } }], interpolation: "smooth", loopClosure: "auto" }),
  rise: (): CameraPath => twoPointPath(0, 0, -12, 20, 1, 1),
  fall: (): CameraPath => twoPointPath(0, 0, 20, -12, 1, 1),
  dollyIn: (): CameraPath => twoPointPath(0, 0, 0, 0, 1.3, 0.72),
  dollyOut: (): CameraPath => twoPointPath(0, 0, 0, 0, 0.72, 1.3)
} satisfies Record<string, () => CameraPath>;

function normalizeKeyframe(keyframe: CameraKeyframe, index: number): NormalizedCameraKeyframe {
  if (!keyframe || typeof keyframe !== "object") throw new Error(`CameraPath keyframe ${index} is invalid.`);
  const time = unitInterval(keyframe.time, `CameraPath keyframe ${index} time`);
  const orbit = {
    azimuth: finite(keyframe.orbit?.azimuth ?? keyframe.azimuth ?? 0, `CameraPath keyframe ${index} azimuth`),
    elevation: finite(keyframe.orbit?.elevation ?? keyframe.elevation ?? 0, `CameraPath keyframe ${index} elevation`),
    distance: finite(keyframe.orbit?.distance ?? keyframe.distance ?? 1, `CameraPath keyframe ${index} distance`)
  };
  if (orbit.distance <= 0) throw new Error(`CameraPath keyframe ${index} distance must be positive.`);
  if (Math.abs(orbit.elevation) > 90) throw new Error(`CameraPath keyframe ${index} elevation must be between -90 and 90 degrees.`);
  for (const vector of [keyframe.position, keyframe.target]) if (vector) for (const value of [vector.x, vector.y, vector.z]) finite(value, `CameraPath keyframe ${index} vector component`);
  if (keyframe.orientation) for (const value of [keyframe.orientation.yaw, keyframe.orientation.pitch, keyframe.orientation.roll ?? 0]) finite(value, `CameraPath keyframe ${index} orientation`);
  if (keyframe.lens?.focalLengthMm !== undefined && keyframe.lens.focalLengthMm <= 0) throw new Error("CameraPath focalLengthMm must be positive.");
  if (keyframe.lens?.fieldOfViewDegrees !== undefined && (keyframe.lens.fieldOfViewDegrees <= 0 || keyframe.lens.fieldOfViewDegrees >= 180)) throw new Error("CameraPath fieldOfViewDegrees must be between 0 and 180.");
  return { ...keyframe, time, orbit };
}

function twoPointPath(startAzimuth: number, endAzimuth: number, startElevation: number, endElevation: number, startDistance: number, endDistance: number): CameraPath {
  return { schemaVersion: "1.0", keyframes: [{ time: 0, orbit: { azimuth: startAzimuth, elevation: startElevation, distance: startDistance } }, { time: 1, orbit: { azimuth: endAzimuth, elevation: endElevation, distance: endDistance } }], interpolation: "smooth" };
}
function unwrapAngle(previous: number, current: number) {
  const raw = current - previous;
  if (Math.abs(raw) >= 359.999) return current;
  let candidate = current;
  while (candidate - previous > 180) candidate -= 360;
  while (candidate - previous < -180) candidate += 360;
  return candidate;
}
function shortAngleDelta(a: number, b: number) { let delta = b - a; while (delta > 180) delta -= 360; while (delta < -180) delta += 360; return delta; }
function remapHoldTime(time: number, startHold: number, endHold: number) { if (time <= startHold) return 0; if (time >= 1 - endHold) return 1; return (time - startHold) / (1 - startHold - endHold); }
function roundProviderNumber(value: number) { return Number(value.toFixed(9)); }
function pose(frame: NormalizedCameraKeyframe, time: number): H3MaxCameraPose { return { time, ...frame.orbit }; }
function cameraMotionMagnitude(a: CameraOrbit, b: CameraOrbit) { return Math.abs(a.azimuth - b.azimuth) + Math.abs(a.elevation - b.elevation) + Math.abs(a.distance - b.distance); }
function lerp(a: number, b: number, amount: number) { return a + (b - a) * amount; }
function percent(value: number) { return `${Math.round(value * 100)}% of the shot`; }
function finite(value: number, label: string) { if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`); return value; }
function unitInterval(value: number, label: string) { finite(value, label); if (value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1.`); return value; }
function validateSubjectBox(box: CameraSubjectBox) { for (const value of [box.x, box.y, box.width, box.height]) unitInterval(value, "CameraPath subjectBox value"); if (box.width <= 0 || box.height <= 0 || box.x + box.width > 1 || box.y + box.height > 1) throw new Error("CameraPath subjectBox must be a positive normalized rectangle contained by the frame."); }

// Monotone cubic Hermite interpolation (PCHIP-style slopes) avoids overshoot at holds and reversals.
// The portable design is independently adapted from the camera-path concepts documented by
// NyckM/3d-Camera-control-H3-Minimax (Apache-2.0, revision 36c4218a2561328436d440fa9134631ee515471b).
function monotoneCubic(xs: number[], ys: number[], segment: number, x: number) {
  const slopes = pchipSlopes(xs, ys), x0 = xs[segment]!, x1 = xs[segment + 1]!, y0 = ys[segment]!, y1 = ys[segment + 1]!, h = x1 - x0, t = (x - x0) / h;
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
  return h00 * y0 + h10 * h * slopes[segment]! + h01 * y1 + h11 * h * slopes[segment + 1]!;
}
function pchipSlopes(xs: number[], ys: number[]) {
  if (xs.length === 1) return [0];
  const intervals = xs.slice(0, -1).map((x, index) => xs[index + 1]! - x), secants = intervals.map((h, index) => (ys[index + 1]! - ys[index]!) / h), slopes = new Array<number>(xs.length).fill(0);
  if (xs.length === 2) return [secants[0]!, secants[0]!];
  slopes[0] = endpointSlope(intervals[0]!, intervals[1]!, secants[0]!, secants[1]!);
  slopes[slopes.length - 1] = endpointSlope(intervals.at(-1)!, intervals.at(-2)!, secants.at(-1)!, secants.at(-2)!);
  for (let index = 1; index < xs.length - 1; index++) {
    const before = secants[index - 1]!, after = secants[index]!;
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) slopes[index] = 0;
    else { const leftWeight = 2 * intervals[index]! + intervals[index - 1]!, rightWeight = intervals[index]! + 2 * intervals[index - 1]!; slopes[index] = (leftWeight + rightWeight) / (leftWeight / before + rightWeight / after); }
  }
  return slopes;
}
function endpointSlope(h0: number, h1: number, d0: number, d1: number) { let slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1); if (Math.sign(slope) !== Math.sign(d0)) slope = 0; else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(slope) > Math.abs(3 * d0)) slope = 3 * d0; return slope; }
