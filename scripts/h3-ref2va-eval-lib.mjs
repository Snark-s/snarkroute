import { dirname, resolve } from "node:path";

const VALID_KINDS = new Set(["image", "video", "audio"]);

export function normalizePlan(raw, planPath) {
  if (!raw || !Array.isArray(raw.tests) || !raw.tests.length) {
    throw new Error("Ref2VA evaluation plan needs a non-empty tests array.");
  }
  const base = dirname(resolve(planPath));
  const defaults = {
    seed: 424242,
    steps: 4,
    durationSeconds: 5,
    aspectRatio: "16:9",
    modelVariant: "h3_base",
    ...(raw.defaults ?? {}),
  };
  const ids = new Set();
  const tests = raw.tests.map((input) => {
    const test = { ...defaults, ...input };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(test.id ?? "")) {
      throw new Error(`Invalid test id: ${test.id ?? "<missing>"}`);
    }
    if (ids.has(test.id)) throw new Error(`Duplicate test id: ${test.id}`);
    ids.add(test.id);
    if (!String(test.prompt ?? "").trim()) throw new Error(`${test.id} needs a prompt.`);
    const counters = { image: 0, video: 0, audio: 0 };
    const references = (test.references ?? []).map((reference) => {
      if (!VALID_KINDS.has(reference.kind)) throw new Error(`${test.id} has an invalid reference kind.`);
      counters[reference.kind] += 1;
      const noun = reference.kind === "image" ? "Picture" : reference.kind === "video" ? "Video" : "Audio";
      return {
        ...reference,
        path: resolve(base, reference.path),
        tag: `${noun} ${counters[reference.kind]}`,
      };
    });
    const contextInstruction = String(test.contextInstruction ?? "").trim();
    const prompt = String(test.prompt).trim();
    return {
      ...test,
      prompt,
      contextInstruction,
      finalPrompt: contextInstruction ? `${contextInstruction}\n\n${prompt}` : prompt,
      references,
    };
  });
  return { ...raw, defaults, planPath: resolve(planPath), tests };
}

export function buildWorkerRequest(test, uploadedUris) {
  if (uploadedUris.length !== test.references.length) throw new Error(`${test.id}: uploaded reference count mismatch.`);
  const conditions = test.references.map((reference, index) => ({
    type: reference.kind,
    uri: uploadedUris[index],
    role: "reference",
    ...(reference.purpose ? { purpose: reference.purpose } : {}),
    ...(reference.kind === "video" && reference.startTimeSeconds !== undefined
      ? { start_time_seconds: reference.startTimeSeconds }
      : {}),
    ...(reference.kind === "video" && reference.visualMode === "motion"
      ? { visual_mode: "motion" }
      : {}),
  }));
  return {
    operation: "video.generate.h3",
    task: conditions.length ? "ref2va" : "t2va",
    prompt: test.finalPrompt,
    conditions,
    target: {
      short_edge: 768,
      aspect_ratio: test.aspectRatio,
      duration_seconds: test.durationSeconds,
    },
    seed: test.seed,
    num_outputs_per_prompt: 1,
    num_inference_steps: test.steps,
    quality_mode: "preview",
    quality: "lossless",
    turbo_lora: false,
    ...(test.modelVariant && test.modelVariant !== "h3_base" ? { model_variant: test.modelVariant } : {}),
    ...(test.identityTransfer?.enabled
      ? { identity_transfer: { enabled: true, strength: test.identityTransfer.strength ?? 1 } }
      : {}),
  };
}

export function summarizeRun(items) {
  return items.reduce((summary, item) => {
    if (item.status === "succeeded") summary.succeeded += 1;
    else if (item.status === "failed" || item.status === "cancelled") summary.failed += 1;
    else summary.pending += 1;
    return summary;
  }, { total: items.length, succeeded: 0, failed: 0, pending: 0 });
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
