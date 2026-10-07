import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addExactDuplicateWarnings, addImportAssetAsReference, analyzeComfyWorkflow, analyzeImportSet, attachImportFileToReference, changeImportReferenceSource, compatibleImportCandidates, compatibleImportTargets, extractReferenceContext, importAssignmentConflict, importReferenceContext, importReferenceLabel, importReferenceUiGroup, mediaKindForImportFile, resolveImportReference, swapImportReferenceSources, unassignImportReference, useImportAssetAsVideoOne, videoOneImportCandidates, type H3ImportAnalysis } from "./h3ImportSet";

const trainSceneFixture = JSON.parse(readFileSync(new URL("./fixtures/API_Minimax_Max_TrainScene.json", import.meta.url), "utf8"));

describe("H3 Import Set adapter", () => {
  it("imports loose media without inventing semantic roles", () => {
    const analysis = analyzeImportSet([
      { key: "character.png", name: "character.png", type: "image/png" },
      { key: "motion.mp4", name: "motion.mp4", type: "video/mp4" },
      { key: "score.wav", name: "score.wav", type: "audio/wav" },
    ], []);

    expect(analysis.sourceType).toBe("loose_files");
    expect(analysis.references.map((reference) => reference.kind)).toEqual(["image", "video", "audio"]);
    expect(analysis.references.every((reference) => reference.classification === "loose" && reference.disposition === "active")).toBe(true);
  });

  it("does not treat an unknown JSON file as a prompt", () => {
    const analysis = analyzeImportSet([], [{ fileName: "settings.json", value: { arbitrary: "data" } }]);
    expect(analysis.sourceType).toBe("unknown_json");
    expect(analysis.prompt).toBeUndefined();
    expect(analysis.warnings[0]).toMatch(/not treated as a prompt/i);
  });

  it("detects media types by MIME or extension", () => {
    expect(mediaKindForImportFile({ name: "one.PNG" })).toBe("image");
    expect(mediaKindForImportFile({ name: "two", type: "video/mp4" })).toBe("video");
    expect(mediaKindForImportFile({ name: "notes.txt" })).toBeNull();
  });
});

describe("API_Minimax_Max_TrainScene regression", () => {
  it("extracts generation metadata and keeps the unconnected video orphaned", () => {
    const analysis = analyzeComfyWorkflow(trainSceneFixture, [], "API_Minimax_Max_TrainScene.json");
    const connectedImages = analysis.references.filter((reference) => reference.kind === "image" && reference.connected);
    const videos = analysis.references.filter((reference) => reference.kind === "video");

    expect(analysis.model).toBe("MiniMax H3 Max");
    expect(analysis.generation).toMatchObject({
      resolution: "768P",
      ratio: "adaptive",
      duration: 15,
      promptExpansionMode: "balanced",
      referenceDetail: "high",
      seed: 2719868943,
      watermark: false,
    });
    expect(connectedImages).toHaveLength(5);
    expect(analysis.prompt).toContain("<Video 1>");
    expect(analysis.contextIr.detected).toBe(true);
    expect(analysis.stages).toMatchObject({
      promptEnhanceDetected: true,
      promptEnhanceEnabled: false,
      regenerate2kDetected: true,
      regenerate2kEnabled: false,
      saveTextDetected: true,
      saveVideoCount: 2,
    });
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ connected: false, classification: "orphaned", disposition: "unused" });
    expect(analysis.references.filter((reference) => reference.kind === "video" && reference.disposition === "active")).toHaveLength(0);
    expect(analysis.warnings.some((warning) => warning.includes("<Video 1>") && warning.includes("not connected"))).toBe(true);
  });

  it("matches connected files by exact filename and leaves missing sources as placeholders", () => {
    const analysis = analyzeComfyWorkflow(trainSceneFixture, [
      { key: "first", name: "0b416917a2288d6947429819b4eece092c65fab81c2b72bb5bc9515645ccd1d0.png" },
    ]);
    const images = analysis.references.filter((reference) => reference.kind === "image");
    expect(images[0]).toMatchObject({ matchedFileKey: "first", missing: false });
    expect(images.filter((reference) => reference.missing)).toHaveLength(4);
  });

  it("keeps extra media beside a workflow visible as an unused asset", () => {
    const analysis = analyzeComfyWorkflow(trainSceneFixture, [
      { key: "extra", name: "behind-the-scenes.mp4", type: "video/mp4" },
    ]);
    expect(analysis.references.find((reference) => reference.matchedFileKey === "extra")).toMatchObject({
      connected: false,
      classification: "orphaned",
      disposition: "unused",
    });
  });
});

describe("manual Import Set resolution", () => {
  const trainSceneWithLooseFiles = () => analyzeComfyWorkflow(trainSceneFixture, [
    ...Array.from({ length: 5 }, (_, index) => ({ key: `photo-${index + 1}`, name: `photo-${index + 1}.jpg`, type: "image/jpeg", size: 100 + index })),
    { key: "video-a", name: "motion-a.mp4", type: "video/mp4", size: 200 },
    { key: "video-b", name: "motion-b.mp4", type: "video/mp4", size: 201 },
  ]);

  const firstMissingImage = (analysis: H3ImportAnalysis) => analysis.references.find((reference) => reference.connected && reference.kind === "image" && reference.missing)!;
  const firstLooseImage = (analysis: H3ImportAnalysis) => analysis.references.find((reference) => !reference.connected && reference.kind === "image" && reference.matchedFileKey)!;

  it("resolves an existing missing image from an imported file", () => {
    const analysis = trainSceneWithLooseFiles();
    const target = firstMissingImage(analysis);
    const candidate = firstLooseImage(analysis);
    const resolved = resolveImportReference(analysis, target.id, candidate.id);
    expect(resolved.references.find((reference) => reference.id === target.id)).toMatchObject({ missing: false, matchedFileKey: candidate.matchedFileKey, resolvedSourceName: candidate.sourceName });
  });

  it("resolves a missing video only from a compatible video", () => {
    const analysis = trainSceneWithLooseFiles();
    const orphanVideo = analysis.references.find((reference) => reference.kind === "video" && reference.matchedFileKey)!;
    const target: H3ImportAnalysis = { ...analysis, references: [{ ...firstMissingImage(analysis), id: "video-target", kind: "video", sourceName: "expected.mp4" }, ...analysis.references] };
    expect(resolveImportReference(target, "video-target", orphanVideo.id).references[0]).toMatchObject({ missing: false, matchedFileKey: orphanVideo.matchedFileKey });
  });

  it("rejects an incompatible media kind", () => {
    const analysis = trainSceneWithLooseFiles();
    const image = firstMissingImage(analysis);
    const video = analysis.references.find((reference) => reference.kind === "video" && reference.matchedFileKey)!;
    expect(resolveImportReference(analysis, image.id, video.id)).toBe(analysis);
  });

  it("does not create an extra active reference while resolving", () => {
    const analysis = trainSceneWithLooseFiles();
    const before = analysis.references.filter((reference) => reference.disposition === "active").length;
    const resolved = resolveImportReference(analysis, firstMissingImage(analysis).id, firstLooseImage(analysis).id);
    expect(resolved.references.filter((reference) => reference.disposition === "active")).toHaveLength(before);
  });

  it("preserves connected reference order and numbering", () => {
    const analysis = trainSceneWithLooseFiles();
    const connectedBefore = analysis.references.filter((reference) => reference.connected).map((reference) => reference.id);
    const target = analysis.references.filter((reference) => reference.connected && reference.kind === "image")[2]!;
    const resolved = resolveImportReference(analysis, target.id, firstLooseImage(analysis).id);
    expect(resolved.references.filter((reference) => reference.connected).map((reference) => reference.id)).toEqual(connectedBefore);
    expect(importReferenceLabel(resolved.references.find((reference) => reference.id === target.id)!, resolved.references)).toBe("Picture 3");
  });

  it("keeps prompt tags untouched", () => {
    const analysis = trainSceneWithLooseFiles();
    const resolved = resolveImportReference(analysis, firstMissingImage(analysis).id, firstLooseImage(analysis).id);
    expect(resolved.prompt).toBe(analysis.prompt);
  });

  it("removes a resolved candidate from compatible orphan choices", () => {
    const analysis = trainSceneWithLooseFiles();
    const target = firstMissingImage(analysis);
    const candidate = firstLooseImage(analysis);
    const resolved = resolveImportReference(analysis, target.id, candidate.id);
    expect(resolved.references.find((reference) => reference.id === candidate.id)).toMatchObject({ disposition: "resolved", resolvedByReferenceId: target.id });
    expect(compatibleImportTargets(resolved, candidate.id)).toEqual([]);
  });

  it("offers only unresolved compatible files for a missing slot", () => {
    const analysis = trainSceneWithLooseFiles();
    const candidates = compatibleImportCandidates(analysis, firstMissingImage(analysis).id);
    expect(candidates).toHaveLength(5);
    expect(candidates.every((candidate) => candidate.kind === "image" && candidate.disposition === "unused")).toBe(true);
  });

  it("suggests imported videos for Video 1 without applying one", () => {
    const analysis = trainSceneWithLooseFiles();
    expect(videoOneImportCandidates(analysis).map((candidate) => candidate.sourceName)).toEqual(["motion-a.mp4", "motion-b.mp4"]);
    expect(analysis.references.filter((reference) => reference.kind === "video" && reference.disposition === "active")).toHaveLength(0);
  });

  it("offers the single remaining video as an explicit Video 1 suggestion", () => {
    const analysis = trainSceneWithLooseFiles();
    const firstVideo = videoOneImportCandidates(analysis)[0]!;
    const withFirstIgnored = { ...analysis, references: analysis.references.map((reference) => reference.id === firstVideo.id ? { ...reference, disposition: "ignored" as const } : reference) };
    expect(videoOneImportCandidates(withFirstIgnored).map((candidate) => candidate.sourceName)).toEqual(["motion-b.mp4"]);
    expect(withFirstIgnored.references.some((reference) => reference.manualRole === "Video 1")).toBe(false);
  });

  it("requires an explicit selection when multiple Video 1 candidates exist", () => {
    const analysis = trainSceneWithLooseFiles();
    const candidates = videoOneImportCandidates(analysis);
    const selected = useImportAssetAsVideoOne(analysis, candidates[1]!.id);
    expect(selected.references.find((reference) => reference.id === candidates[1]!.id)).toMatchObject({ disposition: "active", manualRole: "Video 1" });
    expect(selected.references.find((reference) => reference.id === candidates[0]!.id)?.disposition).toBe("unused");
  });

  it("warns only for exact size-and-checksum duplicate groups", () => {
    const analysis = trainSceneWithLooseFiles();
    const warned = addExactDuplicateWarnings(analysis, [
      { key: "a", name: "first.jpg", size: 10, sha256: "abc" },
      { key: "b", name: "renamed.jpg", size: 10, sha256: "abc" },
      { key: "c", name: "first.jpg", size: 11, sha256: "different" },
    ]);
    expect(warned.warnings.filter((warning) => /exact duplicate/i.test(warning))).toEqual([expect.stringContaining("first.jpg, renamed.jpg")]);
  });

  it("keeps Add as new reference separate from resolving a slot", () => {
    const analysis = trainSceneWithLooseFiles();
    const candidate = firstLooseImage(analysis);
    const added = addImportAssetAsReference(analysis, candidate.id);
    expect(added.references.find((reference) => reference.id === candidate.id)).toMatchObject({ disposition: "active", connected: false });
    expect(firstMissingImage(added).missing).toBe(true);
  });

  it("attaches a browsed compatible file to the same placeholder", () => {
    const analysis = trainSceneWithLooseFiles();
    const target = firstMissingImage(analysis);
    const attached = attachImportFileToReference(analysis, target.id, { key: "browse", name: "chosen.jpg", type: "image/jpeg" });
    expect(attached.references.find((reference) => reference.id === target.id)).toMatchObject({ id: target.id, missing: false, matchedFileKey: "browse", resolvedSourceName: "chosen.jpg" });
    expect(attached.references).toHaveLength(analysis.references.length + 1);
    expect(attached.references.find((reference) => reference.resolvedByReferenceId === target.id)).toMatchObject({ sourceName: "chosen.jpg", disposition: "resolved" });
  });

  it("resolves all five TrainScene picture slots while keeping the second video unused", () => {
    let analysis = trainSceneWithLooseFiles();
    const targets = analysis.references.filter((reference) => reference.connected && reference.kind === "image");
    const candidates = analysis.references.filter((reference) => !reference.connected && reference.kind === "image" && reference.matchedFileKey);
    for (let index = 0; index < targets.length; index += 1) analysis = resolveImportReference(analysis, targets[index]!.id, candidates[index]!.id);
    const videos = videoOneImportCandidates(analysis);
    analysis = useImportAssetAsVideoOne(analysis, videos[0]!.id);
    expect(analysis.references.filter((reference) => reference.connected && reference.kind === "image" && reference.missing)).toHaveLength(0);
    expect(analysis.references.filter((reference) => reference.kind === "image" && reference.disposition === "active")).toHaveLength(5);
    expect(analysis.references.find((reference) => reference.id === videos[1]!.id)?.disposition).toBe("unused");
  });
});

describe("reference context and reversible assignments", () => {
  const files = [
    { key: "one", name: "one.jpg", type: "image/jpeg" },
    { key: "two", name: "two.jpg", type: "image/jpeg" },
  ];
  const setup = () => analyzeComfyWorkflow(trainSceneFixture, files);

  it("extracts the original Picture 1 paragraph without rewriting", () => {
    const snippet = importReferenceContext(setup(), "Picture 1")[0]!;
    expect(snippet).toContain("<Picture 1> is the exterior location viewed from above.");
    expect(snippet).toContain("train exterior, colors, and cartoon art style");
  });

  it("returns the shared paragraph for Picture 2 and Picture 3", () => {
    const analysis = setup();
    expect(importReferenceContext(analysis, "Picture 2")).toEqual(importReferenceContext(analysis, "Picture 3"));
    expect(importReferenceContext(analysis, "Picture 2")[0]).toContain("character references");
  });

  it("extracts Video 1 context and keeps multiple mentions", () => {
    const snippets = importReferenceContext(setup(), "Video 1");
    expect(snippets).toHaveLength(2);
    expect(snippets[0]).toContain("3D blockout");
    expect(snippets[1]).toContain("camera path and sequence");
  });

  it("falls back to mention sentences for an oversized paragraph", () => {
    const text = `${"Prelude sentence. ".repeat(50)}<Picture 1> is the reference. Use it exactly. ${"Tail sentence. ".repeat(50)}`;
    expect(extractReferenceContext(text, "<Picture 1>")).toEqual(["<Picture 1> is the reference. Use it exactly."]);
  });

  it("changes a resolved source and releases the previous file", () => {
    let analysis = setup();
    const target = analysis.references.find((reference) => reference.connected && reference.kind === "image")!;
    const candidates = analysis.references.filter((reference) => !reference.connected && reference.kind === "image" && reference.matchedFileKey);
    analysis = resolveImportReference(analysis, target.id, candidates[0]!.id);
    analysis = changeImportReferenceSource(analysis, target.id, candidates[1]!.id);
    expect(analysis.references.find((reference) => reference.id === target.id)?.matchedFileKey).toBe("two");
    expect(analysis.references.find((reference) => reference.id === candidates[0]!.id)?.disposition).toBe("unused");
  });

  it("unassigns a source back to Missing without deleting the slot", () => {
    let analysis = setup();
    const target = analysis.references.find((reference) => reference.connected && reference.kind === "image")!;
    const candidate = analysis.references.find((reference) => !reference.connected && reference.kind === "image" && reference.matchedFileKey)!;
    analysis = resolveImportReference(analysis, target.id, candidate.id);
    const unassigned = unassignImportReference(analysis, target.id);
    expect(unassigned.references.find((reference) => reference.id === target.id)).toMatchObject({ id: target.id, missing: true });
    expect(unassigned.references.find((reference) => reference.id === candidate.id)?.disposition).toBe("unused");
    expect(unassigned.prompt).toBe(analysis.prompt);
  });

  it("detects an already-assigned candidate and swaps sources explicitly", () => {
    let analysis = setup();
    const targets = analysis.references.filter((reference) => reference.connected && reference.kind === "image").slice(0, 2);
    const candidates = analysis.references.filter((reference) => !reference.connected && reference.kind === "image" && reference.matchedFileKey);
    analysis = resolveImportReference(analysis, targets[0]!.id, candidates[0]!.id);
    analysis = resolveImportReference(analysis, targets[1]!.id, candidates[1]!.id);
    expect(importAssignmentConflict(analysis, targets[0]!.id, candidates[1]!.id)?.id).toBe(targets[1]!.id);
    const swapped = swapImportReferenceSources(analysis, targets[0]!.id, targets[1]!.id);
    expect(swapped.references.find((reference) => reference.id === targets[0]!.id)?.matchedFileKey).toBe("two");
    expect(swapped.references.find((reference) => reference.id === targets[1]!.id)?.matchedFileKey).toBe("one");
  });

  it("never silently duplicates a source already assigned to another slot", () => {
    let analysis = setup();
    const targets = analysis.references.filter((reference) => reference.connected && reference.kind === "image").slice(0, 2);
    const candidate = analysis.references.find((reference) => !reference.connected && reference.kind === "image" && reference.matchedFileKey)!;
    analysis = resolveImportReference(analysis, targets[0]!.id, candidate.id);
    expect(changeImportReferenceSource(analysis, targets[1]!.id, candidate.id)).toBe(analysis);
  });

  it("moves an assigned asset out of the orphan-actions UI group", () => {
    let analysis = setup();
    const target = analysis.references.find((reference) => reference.connected && reference.kind === "image")!;
    const candidate = analysis.references.find((reference) => !reference.connected && reference.kind === "image" && reference.matchedFileKey)!;
    expect(importReferenceUiGroup(candidate)).toBe("orphan");
    analysis = resolveImportReference(analysis, target.id, candidate.id);
    expect(importReferenceUiGroup(analysis.references.find((reference) => reference.id === candidate.id)!)).toBe("hidden");
    expect(importReferenceUiGroup(analysis.references.find((reference) => reference.id === target.id)!)).toBe("slot");
  });

  it("covers every TrainScene reference description from imported text", () => {
    const analysis = setup();
    expect(importReferenceContext(analysis, "Picture 1").join(" ")).toMatch(/exterior location.*train exterior.*cartoon art style/s);
    expect(importReferenceContext(analysis, "Picture 2").join(" ")).toContain("character references");
    expect(importReferenceContext(analysis, "Picture 3").join(" ")).toContain("character references");
    expect(importReferenceContext(analysis, "Picture 4").join(" ")).toMatch(/train interior.*seating.*windows.*hand straps/s);
    expect(importReferenceContext(analysis, "Picture 5").join(" ")).toMatch(/cap and C-logo.*C emblem/s);
    expect(importReferenceContext(analysis, "Video 1").join(" ")).toMatch(/3D blockout.*camera movement.*timing.*object placement.*animation/s);
  });
});
