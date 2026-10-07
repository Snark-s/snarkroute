import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildQueueSubmission, composerSeedFromImported, composeFinalRequest, formatMediaDuration, ImportMediaPreview, insertAtSelection, isPersistentQueueSource, materializeImportReferences, moveComposerAsset, normalizeComposerDraft, operationForComposer, QueueCard, queueSubmissionError, referenceTag, revokeImportPreviewUrls, taskFamilyForOperation, type ComposerAsset } from "./H3QueuePanel";
import { analyzeComfyWorkflow, resolveImportReference, useImportAssetAsVideoOne } from "./h3ImportSet";
import { VisualModifierControls } from "./H3QueuePanel";

describe("registry-driven Visual Modifier controls", () => {
  const modifier = { id: "authentic_cinematic_texture" as const, title: "Registry title", category: "visual" as const, repository: "repo", revision: "revision", filename: "texture.safetensors", weights_installed: true, capability_status: "limited", default_strength: 0.7, motion_strength: 0.5, notes: "Registry notes" };
  const props = { id: modifier.id, enabled: true, strength: 0.7, includeTrigger: false, disabled: false, busy: false, onId: () => {}, onEnabled: () => {}, onStrength: () => {}, onTrigger: () => {}, onDownload: () => {} };
  it("uses registry title/recommendations and hides an undeclared trigger", () => {
    const html = renderToStaticMarkup(createElement(VisualModifierControls, { ...props, modifiers: [modifier] }));
    expect(html).toContain("Registry title");
    expect(html).toContain("Registry notes");
    expect(html).toContain("Motion · 0.5");
    expect(html).not.toContain("Include trigger");
    expect(html).not.toContain("Download Registry title");
  });
  it("shows declared trigger and download status from the registry", () => {
    const html = renderToStaticMarkup(createElement(VisualModifierControls, { ...props, modifiers: [{ ...modifier, trigger: "DY", weights_installed: false }] }));
    expect(html).toContain("Include trigger: DY");
    expect(html).toContain("Download Registry title");
  });
});

const trainSceneFixture = JSON.parse(readFileSync(new URL("./fixtures/API_Minimax_Max_TrainScene.json", import.meta.url), "utf8"));

describe("H3 prompt tag insertion", () => {
  it("inserts a media tag at the cursor", () => {
    expect(insertAtSelection("Use  for motion", "<Video 1>", 4, 4)).toEqual({
      value: "Use <Video 1> for motion",
      cursor: 13,
    });
  });

  it("replaces the selected prompt text", () => {
    expect(insertAtSelection("Use placeholder here", "<Picture 1>", 4, 15)).toEqual({
      value: "Use <Picture 1> here",
      cursor: 15,
    });
  });
});

describe("H3 import media previews", () => {
  const file = { name: "asset.jpg" } as File;

  it("renders an image thumbnail for an imported image", () => {
    const html = renderToStaticMarkup(createElement(ImportMediaPreview, { file, url: "blob:image-preview", kind: "image", name: "asset.jpg" }));
    expect(html).toContain('<img src="blob:image-preview"');
    expect(html).toContain("Preview of asset.jpg");
  });

  it("renders the same image preview for resolved and orphan card inputs", () => {
    const resolved = renderToStaticMarkup(createElement(ImportMediaPreview, { file, url: "blob:resolved", kind: "image", name: "resolved.jpg" }));
    const orphaned = renderToStaticMarkup(createElement(ImportMediaPreview, { file, url: "blob:orphaned", kind: "image", name: "orphaned.jpg" }));
    expect(resolved).toContain("blob:resolved");
    expect(orphaned).toContain("blob:orphaned");
  });

  it("exposes an inline video poster/play surface", () => {
    const html = renderToStaticMarkup(createElement(ImportMediaPreview, { file: { name: "motion.mp4" } as File, url: "blob:video-preview", kind: "video", name: "motion.mp4" }));
    expect(html).toContain("<video");
    expect(html).toContain("controls");
    expect(html).toContain('preload="metadata"');
  });

  it("formats media duration without loading the whole file", () => {
    expect(formatMediaDuration(65.4)).toBe("1:05");
  });

  it("revokes every object URL during preview cleanup", () => {
    const revoked: string[] = [];
    revokeImportPreviewUrls(["blob:one", "blob:two"], (url) => revoked.push(url));
    expect(revoked).toEqual(["blob:one", "blob:two"]);
  });
});

describe("H3 native composer state", () => {
  const asset = (composerId: string, slot: ComposerAsset["slot"], kind: ComposerAsset["kind"]): ComposerAsset => ({ composerId, slot, kind, path: `C:/${composerId}`, filename: composerId, mimeType: `${kind}/test` });

  it("maps every FL2VA frame combination through the legacy adapter", () => {
    const first = asset("first", "firstFrame", "image");
    const last = asset("last", "lastFrame", "image");
    expect(operationForComposer("FL2VA", [], "reference_mix")).toBe("text_to_video");
    expect(operationForComposer("FL2VA", [first], "reference_mix")).toBe("first_last_frame");
    expect(operationForComposer("FL2VA", [last], "reference_mix")).toBe("first_last_frame");
    expect(operationForComposer("FL2VA", [first, last], "reference_mix")).toBe("first_last_frame");
    expect(operationForComposer("FL2VA", [first, last].filter((item) => item.composerId !== "first"), "reference_mix")).toBe("first_last_frame");
    expect(operationForComposer("FL2VA", [], "motion_transfer")).toBe("text_to_video");
  });

  it("keeps legacy recipes secondary to the Ref2VA task family", () => {
    expect(operationForComposer("Ref2VA", [], "motion_transfer")).toBe("motion_transfer");
    expect(taskFamilyForOperation("reference_mix")).toBe("Ref2VA");
    expect(taskFamilyForOperation("first_last_frame")).toBe("FL2VA");
  });

  it("keeps Prompt and Context separate while composing the final request", () => {
    expect(composeFinalRequest("FL2VA", "Scene", "motion", "Ignored context")).toBe("Scene");
    expect(composeFinalRequest("Ref2VA", "Scene", "none", "Use <Picture 1> for identity.")).toBe("Use <Picture 1> for identity.\n\nScene");
  });

  it("reorders references without renumbering across media kinds", () => {
    const picture1 = asset("p1", "referenceImage", "image");
    const video1 = asset("v1", "referenceVideo", "video");
    const picture2 = asset("p2", "referenceImage", "image");
    const reordered = moveComposerAsset([picture1, video1, picture2], "p2", -1);
    expect(reordered.map((item) => item.composerId)).toEqual(["p1", "p2", "v1"]);
    expect(referenceTag(picture1, reordered)).toBe("Picture 1");
    expect(referenceTag(picture2, reordered)).toBe("Picture 2");
    expect(referenceTag(video1, reordered)).toBe("Video 1");
  });

  it("restores the persisted task family, fields, references, and modifiers", () => {
    const restored = normalizeComposerDraft({
      version: 1,
      taskFamily: "Ref2VA",
      recipeOperation: "reference_mix",
      prompt: "Persisted prompt",
      contextInstruction: "Persisted context",
      contextPreset: "raw",
      assets: [asset("p1", "referenceImage", "image")],
      cameraEnabled: true,
      identityEnabled: true,
    });
    expect(restored).toMatchObject({ taskFamily: "Ref2VA", prompt: "Persisted prompt", contextInstruction: "Persisted context", contextPreset: "raw", cameraEnabled: true, identityEnabled: true });
    expect(restored.assets).toHaveLength(1);
  });
});

describe("H3 queue submission regression", () => {
  const asset = (composerId: string, slot: ComposerAsset["slot"], kind: ComposerAsset["kind"], path = `C:/h3-assets/${composerId}`): ComposerAsset => ({ composerId, slot, kind, path, filename: `${composerId}.${kind === "image" ? "png" : "mp4"}`, mimeType: `${kind}/test` });
  const submission = (assets: ComposerAsset[], overrides: Record<string, unknown> = {}) => ({
    taskFamily: "Ref2VA" as const,
    title: "Train Scene",
    operation: "reference_mix" as const,
    prompt: "Train scene",
    finalRequest: "Use <Video 1> for motion.\n\nTrain scene",
    promptJson: "",
    contextInstruction: "Use <Video 1> for motion.",
    contextPreset: "raw" as const,
    duration: 15,
    aspectRatio: "adaptive",
    variants: 1,
    renderMode: "preview" as const,
    modelVariant: "h3_base" as const,
    inferenceSteps: 4,
    assets,
    identityEnabled: false,
    identityStrength: 1,
    visualModifierEnabled: false,
    visualModifierStrength: 0.7,
    visualModifierTrigger: false,
    cameraEnabled: false,
    cameraMode: "auto" as const,
    seed: "",
    ...overrides,
  });

  function resolvedTrainScene() {
    const descriptors = [
      ...Array.from({ length: 5 }, (_, index) => ({ key: `picture-${index + 1}`, name: `picture-${index + 1}.png`, type: "image/png" })),
      { key: "video-1", name: "motion.mp4", type: "video/mp4" },
    ];
    let analysis = analyzeComfyWorkflow(trainSceneFixture, descriptors);
    const targets = analysis.references.filter((reference) => reference.connected && reference.kind === "image");
    const candidates = analysis.references.filter((reference) => !reference.connected && reference.kind === "image" && reference.matchedFileKey);
    targets.forEach((target, index) => { analysis = resolveImportReference(analysis, target.id, candidates[index]!.id); });
    analysis = useImportAssetAsVideoOne(analysis, analysis.references.find((reference) => reference.kind === "video" && reference.matchedFileKey)!.id);
    const files = new Map(descriptors.map((descriptor) => [descriptor.key, { name: descriptor.name, type: descriptor.type } as File]));
    return { analysis, files };
  }

  it("builds the normal manual Ref2VA queue request", () => {
    const request = buildQueueSubmission(submission([asset("picture", "referenceImage", "image"), asset("video", "referenceVideo", "video")]));
    expect(request).toMatchObject({ operation: "reference_mix", prompt: expect.stringContaining("Train scene"), modelVariant: "h3_base" });
    expect(request.assets).toHaveLength(2);
  });

  it("adds the visual modifier only to H3 Base and preserves trigger choice", () => {
    const request = buildQueueSubmission(submission([asset("picture", "referenceImage", "image")], { visualModifierEnabled: true, visualModifierStrength: 0.5, visualModifierTrigger: true }));
    expect(request.visualModifier).toEqual({ id: "authentic_cinematic_texture", enabled: true, strength: 0.5, includeTrigger: true });
    expect(buildQueueSubmission(submission([asset("picture", "referenceImage", "image")])).visualModifier).toBeNull();
    expect(() => buildQueueSubmission(submission([], { taskFamily: "FL2VA", operation: "text_to_video", modelVariant: "h3_max_turbo", visualModifierEnabled: true }))).toThrow(/requires H3 Base/i);
  });

  it("materializes imported Ref2VA through the same queue request builder", async () => {
    const { analysis, files } = resolvedTrainScene();
    const assets = await materializeImportReferences(analysis, files, async (file, slot, kind) => asset(file.name, slot, kind, `C:/persisted/${file.name}`));
    const request = buildQueueSubmission(submission(assets, { importedWorkflow: analysis }));
    expect(request.operation).toBe("reference_mix");
    expect(request.assets.every((item) => isPersistentQueueSource(item.path))).toBe(true);
  });

  it("enqueues all five resolved TrainScene pictures", async () => {
    const { analysis, files } = resolvedTrainScene();
    const assets = await materializeImportReferences(analysis, files, async (file, slot, kind) => asset(file.name, slot, kind, `C:/persisted/${file.name}`));
    expect(buildQueueSubmission(submission(assets)).assets.filter((item) => item.kind === "image")).toHaveLength(5);
  });

  it("enqueues the manually assigned TrainScene Video 1", async () => {
    const { analysis, files } = resolvedTrainScene();
    const assets = await materializeImportReferences(analysis, files, async (file, slot, kind) => asset(file.name, slot, kind, `C:/persisted/${file.name}`));
    expect(buildQueueSubmission(submission(assets)).assets.filter((item) => item.kind === "video")).toHaveLength(1);
  });

  it("blocks a missing source with a concrete visible error", () => {
    const error = queueSubmissionError(submission([{ ...asset("Picture 3", "referenceImage", "image", ""), missing: true }]));
    expect(error).toBe("Cannot add to queue: Picture 3.png source is unresolved.");
  });

  it("converts browser Files into persistent queue sources before serialization", async () => {
    const { analysis, files } = resolvedTrainScene();
    const assets = await materializeImportReferences(analysis, files, async (file, slot, kind) => asset(file.name, slot, kind, `C:/persisted/${file.name}`));
    expect(assets).toHaveLength(6);
    expect(assets.every((item) => item.path.startsWith("C:/persisted/"))).toBe(true);
  });

  it("never treats an object URL as a persistent queue source", () => {
    expect(isPersistentQueueSource("blob:http://localhost/temp")).toBe(false);
    expect(queueSubmissionError(submission([asset("video", "referenceVideo", "video", "blob:http://localhost/temp")]))).toMatch(/not been uploaded to asset storage/i);
  });

  it("keeps the selected compatible model authoritative over imported metadata", () => {
    const { analysis } = resolvedTrainScene();
    const request = buildQueueSubmission(submission([asset("picture", "referenceImage", "image")], { importedWorkflow: analysis, modelVariant: "h3_base" }));
    expect(request.modelVariant).toBe("h3_base");
    expect((request.promptJson.snarkrouteH3Composer as { importedWorkflow: { model: string } }).importedWorkflow.model).toBe("MiniMax H3 Max");
  });

  it("keeps H3 Max as a hosted model profile without changing the task family", () => {
    const request = buildQueueSubmission(submission([asset("picture", "referenceImage", "image")], { modelVariant: "h3_max", variants: 1, inferenceSteps: 0 }));
    expect(request).toMatchObject({ operation: "reference_mix", modelVariant: "h3_max", variants: 1 });
  });

  it("keeps Turbo capability-aware and rejects semantic reference jobs", () => {
    const t2v = buildQueueSubmission(submission([], { taskFamily: "FL2VA", operation: "text_to_video", modelVariant: "h3_max_turbo", variants: 1, inferenceSteps: 0 }));
    expect(t2v).toMatchObject({ operation: "text_to_video", modelVariant: "h3_max_turbo", variants: 1 });
    expect(() => buildQueueSubmission(submission([asset("picture", "referenceImage", "image")], { modelVariant: "h3_max_turbo", variants: 1, inferenceSteps: 0 }))).toThrow(/semantic references are unavailable/i);
  });

  it("renders the created queue job in the queue card UI", () => {
    const html = renderToStaticMarkup(createElement(QueueCard, {
      item: { id: "job-1", title: "Imported Train Scene", operation: "reference_mix", prompt: "Train", duration: 15, aspectRatio: "adaptive", variants: 1, renderMode: "preview", modelVariant: "h3_base", assets: [asset("picture", "referenceImage", "image")], status: "ready", progress: 0 },
      index: 0, count: 1, busy: false, onLoad: () => undefined, onEdit: () => undefined, onMutate: async () => undefined, onOpenResult: async () => undefined, onToggleSelected: async () => undefined, onArchive: async () => undefined,
    }));
    expect(html).toContain("Imported Train Scene");
    expect(html).toContain("picture.png");
  });

  it("marks non-persistent restored draft assets as needing relinking", () => {
    const restored = normalizeComposerDraft({ version: 1, taskFamily: "Ref2VA", assets: [asset("video", "referenceVideo", "video", "blob:http://localhost/lost")] });
    expect(restored.assets[0]).toMatchObject({ path: "", missing: true });
  });

  it("omits an unsupported imported seed with a warning instead of causing a silent enqueue rejection", () => {
    expect(queueSubmissionError(submission([asset("picture", "referenceImage", "image")], { seed: "2719868943" }))).toMatch(/seed must be an integer between 0 and 2147483647/i);
    expect(composerSeedFromImported(2719868943)).toEqual({ value: "", warning: "Imported seed 2719868943 is outside the H3 runtime range 0–2147483647 and was kept only in workflow metadata." });
  });
});
