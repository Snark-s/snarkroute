import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractImageProvenance } from "../src/libraries/image-metadata";
import { createExecutor } from "@snarkroute/executor";
import { parsePromptPngFile, readPngTextChunk, registerBuiltInNodeRunners, writePngTextChunk } from "@snarkroute/nodes";

const { executeRouteMock } = vi.hoisted(() => ({ executeRouteMock: vi.fn() }));

vi.mock("../src/execution/service", () => ({
  createRouteExecutor: async () => ({ executeRoute: executeRouteMock })
}));

const previousNoListen = process.env.SNARKROUTE_NO_LISTEN;
const previousLibraryPath = process.env.SNARKROUTE_LIBRARY_PATH;
const previousOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const previousCanvasActionsPath = process.env.SNARKROUTE_CANVAS_ACTIONS_PATH;

describe("SnarkRoute libraries", () => {
  let libraryPath: string;

  beforeEach(async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    libraryPath = await mkdtemp(join(tmpdir(), "sr-library-"));
    process.env.SNARKROUTE_LIBRARY_PATH = libraryPath;
    process.env.SNARKROUTE_CANVAS_ACTIONS_PATH = join(libraryPath, ".test-canvas-actions");
    executeRouteMock.mockReset();
  });

  afterEach(() => {
    restoreEnv("SNARKROUTE_NO_LISTEN", previousNoListen);
    restoreEnv("SNARKROUTE_LIBRARY_PATH", previousLibraryPath);
    restoreEnv("OPENROUTER_API_KEY", previousOpenRouterApiKey);
    restoreEnv("SNARKROUTE_CANVAS_ACTIONS_PATH", previousCanvasActionsPath);
  });

  it("creates a portable library manifest and empty canvas", async () => {
    const app = await testServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/libraries/current" });
      expect(response.statusCode).toBe(200);
      expect(response.json().manifest).toMatchObject({ format: "snarkroute.library", version: "0.1", defaultView: "canvas", canvas: "canvas.json" });
      expect(response.json().canvas).toMatchObject({ format: "snarkroute.canvas", nodes: [] });
      expect(JSON.stringify(JSON.parse(await readFile(join(libraryPath, "snark.library.json"), "utf8")))).not.toContain(libraryPath);
    } finally {
      await app.close();
    }
  });

  it("normalizes legacy image provenance metadata when reading", async () => {
    const legacy = writePngTextChunk(Buffer.from(onePixelPngBase64, "base64"), "snarkroute.provenance_json", JSON.stringify({
      format: "snarkroute.image-provenance",
      version: "0.1",
      prompt: "Legacy prompt",
      parameters: {
        prompt: "Legacy prompt",
        promptTemplate: "[[image:source]] - reference.\n\nLegacy prompt",
        images: [{ path: "Y:\\Process\\SnarkRoute\\asset.png", localPath: "Y:\\Process\\SnarkRoute\\asset.png", mimeType: "image/png" }],
        aspectRatio: "auto"
      },
      providerId: "polza",
      modelId: "legacy-model",
      nodeId: "generate",
      createdAt: "2026-01-01T00:00:00.000Z"
    }));

    const metadata = extractImageProvenance(legacy, ".png");
    expect(metadata).toMatchObject({
      schema: "snarkroute.image-metadata.v1",
      generation: {
        providerId: "polza",
        modelId: "legacy-model",
        prompt: { text: "Legacy prompt", template: "[[image:source]] - reference.\n\nLegacy prompt" },
        parameters: { aspectRatio: "auto" },
        inputImages: []
      }
    });
    expect(JSON.stringify(metadata)).not.toContain("localPath");
    expect(JSON.stringify(metadata)).not.toMatch(/[A-Za-z]:\\/);
  });

  it("detects nested libraries without requiring canvas.json", async () => {
    const app = await testServer();
    try {
      await app.inject({ method: "GET", url: "/api/libraries/current" });
      const childPath = join(libraryPath, "characters");
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/create",
        payload: { path: childPath, title: "Characters", libraryKind: "collection", contentKind: "character", defaultView: "grid" }
      });
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.json().manifest).toMatchObject({ libraryKind: "collection", contentKind: "character", defaultView: "grid" });
      expect(createResponse.json().manifest.canvas).toBeUndefined();
      await expect(readFile(join(childPath, "canvas.json"), "utf8")).rejects.toThrow();

      await app.inject({ method: "POST", url: "/api/libraries/open", payload: { path: libraryPath } });
      const response = await app.inject({ method: "GET", url: "/api/libraries/current/nested" });
      expect(response.json().nestedLibraries).toContainEqual(expect.objectContaining({ title: "Characters", libraryKind: "collection", contentKind: "character", hasCanvas: false }));
    } finally {
      await app.close();
    }
  });

  it("creates the first empty text node in a blank canvas", async () => {
    const app = await testServer();
    try {
      await app.inject({ method: "GET", url: "/api/libraries/current" });
      const response = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 500, y: 300, width: 320, height: 180 }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().nodes).toHaveLength(1);
      expect(response.json().nodes[0]).toMatchObject({
        canvas: { type: "text", x: 340, y: 210, width: 320, height: 180 },
        manifest: { type: "text", title: "Text", text: "" },
        stack: [],
        outputText: ""
      });
      const canvas = JSON.parse(await readFile(join(libraryPath, "canvas.json"), "utf8"));
      expect(canvas.nodes).toHaveLength(1);
      expect(canvas.nodes[0].nodePath).toBe("nodes/Text.node");
    } finally {
      await app.close();
    }
  });

  it("creates a sticky note as a portable text node variant", async () => {
    const app = await testServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", variant: "note", x: 500, y: 300, width: 280, height: 220 }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().nodes[0]).toMatchObject({
        canvas: { type: "text", x: 360, y: 190, width: 280, height: 220 },
        manifest: { type: "text", variant: "note", title: "Note", text: "", color: "amber" }
      });
      const storedManifest = JSON.parse(await readFile(join(libraryPath, "nodes", "Note.node", "snark.node.json"), "utf8"));
      expect(storedManifest).toMatchObject({ type: "text", variant: "note", title: "Note", color: "amber" });
    } finally {
      await app.close();
    }
  });

  it("imports an image into a title-matched node folder with stack[0] copied into content", async () => {
    const app = await testServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-image",
        payload: {
          filename: "My Image.png",
          dataBase64: onePixelPngBase64,
          dropX: 500,
          dropY: 300,
          width: 320,
          height: 240
        }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const node = body.nodes[0];
      expect(node.canvas).toMatchObject({ type: "image", x: 340, y: 180, width: 320, height: 240 });
      expect(node.canvas.nodePath).toBe("nodes/My Image.node");
      expect(node.manifest).toMatchObject({ format: "snarkroute.node", type: "image", activeStackIndex: 0 });
      expect(node.manifest.stack[0]).toMatchObject({ file: "content/000-import.png", source: "import", mimeType: "image/png", width: 1, height: 1 });

      const canvas = JSON.parse(await readFile(join(libraryPath, "canvas.json"), "utf8"));
      expect(canvas.nodes[0].nodePath).toBe(node.canvas.nodePath);
      expect(canvas.nodes[0].nodePath).not.toContain("\\");
      expect(canvas.nodes[0].nodePath).not.toContain(libraryPath);

      const nodeFolders = await readdir(join(libraryPath, "nodes"));
      const nodeManifest = JSON.parse(await readFile(join(libraryPath, "nodes", nodeFolders[0], "snark.node.json"), "utf8"));
      expect(nodeManifest.stack[0].file).toBe("content/000-import.png");
      await expect(readFile(join(libraryPath, "nodes", nodeFolders[0], "current-prompt.txt"), "utf8")).resolves.toBe("");
      expect(body.manifest.representativeImage).toEqual({ nodeId: node.manifest.id, stackItemId: node.manifest.stack[0].id });
      await expect(readFile(join(libraryPath, "nodes", nodeFolders[0], "content", "000-import.png"))).resolves.toBeInstanceOf(Buffer);

      await writeFile(join(libraryPath, node.canvas.nodePath, "content", "manual-reference.png"), Buffer.from(onePixelPngBase64, "base64"));
      const refreshed = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json().nodes[0];
      expect(refreshed.manifest.stack[1]).toMatchObject({ file: "content/manual-reference.png", mimeType: "image/png" });
      expect(refreshed.manifest.activeStackIndex).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("persists multiple selected images in an image node stack", async () => {
    const app = await testServer();
    try {
      const imported = (await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-image",
        payload: {
          filename: "Selections.png",
          dataBase64: onePixelPngBase64,
          dropX: 500,
          dropY: 300,
          width: 320,
          height: 240
        }
      })).json();
      const nodeId = imported.nodes[0].manifest.id;
      const appended = (await app.inject({
        method: "POST",
        url: `/api/libraries/current/image-nodes/${nodeId}/stack`,
        payload: { filename: "second.png", dataBase64: onePixelPngBase64 }
      })).json();
      const selectedStackItemIds = appended.nodes[0].manifest.stack.map((item: { id: string }) => item.id);

      const selectedResponse = await app.inject({
        method: "PUT",
        url: `/api/libraries/current/image-nodes/${nodeId}/stack/selected`,
        payload: { selectedStackItemIds }
      });

      expect(selectedResponse.statusCode).toBe(200);
      expect(selectedResponse.json().nodes[0].manifest.selectedStackItemIds).toEqual(selectedStackItemIds);
      const refreshed = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json();
      expect(refreshed.nodes[0].manifest.selectedStackItemIds).toEqual(selectedStackItemIds);

      const deletedResponse = await app.inject({
        method: "DELETE",
        url: `/api/libraries/current/image-nodes/${nodeId}/stack/${selectedStackItemIds[0]}`
      });
      expect(deletedResponse.statusCode).toBe(200);
      expect(deletedResponse.json().nodes[0].manifest.selectedStackItemIds).toEqual([selectedStackItemIds[1]]);
    } finally {
      await app.close();
    }
  });

  it("collects connected mixed assets and materializes collection items as typed nodes", async () => {
    const app = await testServer();
    try {
      const imageSnapshot = (await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-image",
        payload: { filename: "First.png", dataBase64: onePixelPngBase64, dropX: 200, dropY: 200, width: 320, height: 240 }
      })).json();
      const imageNode = imageSnapshot.nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "image");
      const imageWithTwoItems = (await app.inject({
        method: "POST",
        url: `/api/libraries/current/image-nodes/${imageNode.manifest.id}/stack`,
        payload: { filename: "Second.png", dataBase64: onePixelPngBase64 }
      })).json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === imageNode.manifest.id);
      const selectedImageIds = imageWithTwoItems.manifest.stack.map((item: { id: string }) => item.id);
      const selectedImageId = selectedImageIds[1];
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/image-nodes/${imageNode.manifest.id}/stack/selected`,
        payload: { selectedStackItemIds: selectedImageIds }
      });

      const textSnapshot = (await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-text",
        payload: { filename: "Notes.txt", text: "Collection text", dropX: 200, dropY: 500, width: 320, height: 180 }
      })).json();
      const textNode = textSnapshot.nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "text");
      const visualTextPng = writePngTextChunk(Buffer.from(onePixelPngBase64, "base64"), "snarkroute:prompt", JSON.stringify({
        schema: "snarkroute.prompt-image.v0",
        id: "visual-text",
        title: "Visual text",
        category: "text-stack",
        prompt: "Text extracted from an image-backed text item"
      }));
      await writeFile(join(libraryPath, textNode.canvas.nodePath, "content", "visual-text.png"), visualTextPng);
      const refreshedTextNode = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json().nodes
        .find((node: { manifest: { id: string } }) => node.manifest.id === textNode.manifest.id);
      const visualTextItem = refreshedTextNode.stack.find((item: { title: string }) => item.title === "Visual text");
      const importedTextItem = refreshedTextNode.stack.find((item: { text: string }) => item.text === "Collection text");
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/text-nodes/${textNode.manifest.id}/stack/active`,
        payload: { selectedStackItemId: visualTextItem.id }
      });
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/text-nodes/${textNode.manifest.id}/stack/selected`,
        payload: { selectedStackItemIds: [importedTextItem.id] }
      });
      const videoSnapshot = (await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-video",
        payload: { filename: "Clip.mp4", dataBase64: sampleVideoBase64, dropX: 200, dropY: 750, width: 320, height: 240 }
      })).json();
      const videoNode = videoSnapshot.nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "video");
      const videoWithTwoItems = (await app.inject({
        method: "POST",
        url: `/api/libraries/current/video-nodes/${videoNode.manifest.id}/stack`,
        payload: { filename: "Second.mp4", dataBase64: sampleVideoBase64 }
      })).json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === videoNode.manifest.id);
      const selectedVideoId = videoWithTwoItems.manifest.stack[1].id;
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/video-nodes/${videoNode.manifest.id}/stack/selected`,
        payload: { selectedStackItemIds: [selectedVideoId] }
      });

      const collectionSnapshot = (await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "collection", x: 700, y: 450, width: 360, height: 280, connectFromNodeId: imageNode.manifest.id }
      })).json();
      const collectionNode = collectionSnapshot.nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "collection");
      const canvas = collectionSnapshot.canvas;
      canvas.edges.push(
        { id: "edge_text_collection", fromNodeId: textNode.manifest.id, toNodeId: collectionNode.manifest.id },
        { id: "edge_video_collection", fromNodeId: videoNode.manifest.id, toNodeId: collectionNode.manifest.id }
      );
      await app.inject({ method: "PUT", url: "/api/libraries/current/canvas", payload: canvas });

      const collected = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json().nodes
        .find((node: { manifest: { id: string } }) => node.manifest.id === collectionNode.manifest.id);
      expect(collected.items.map((item: { type: string }) => item.type)).toEqual(["image", "image", "text", "video"]);
      const collectedImages = collected.items.filter((item: { type: string }) => item.type === "image");
      expect(new Set(collectedImages.map((item: { file: string }) => item.file)).size).toBe(2);
      const collectedImage = collectedImages.find((item: { stackItemId: string }) => item.stackItemId === selectedImageId);
      expect(collectedImage.stackItemId).toBe(selectedImageId);
      expect((await app.inject({ method: "GET", url: collectedImage.previewUrl })).statusCode).toBe(200);
      expect(collected.items.find((item: { type: string }) => item.type === "text").text).toBe("Collection text");
      expect(collected.items.find((item: { type: string }) => item.type === "text").file).toMatch(/\.prompt\.md$/);
      expect(collected.items.find((item: { type: string }) => item.type === "text").previewUrl).toBeUndefined();
      expect(collected.items.find((item: { type: string }) => item.type === "video").stackItemId).toBe(selectedVideoId);
      expect(collected.manifest.items).toHaveLength(4);
      const collectionContentPath = join(libraryPath, collectionNode.canvas.nodePath, "content");
      const collectedFiles = await readdir(collectionContentPath);
      expect(collectedFiles.filter((file) => file.endsWith(".png"))).toHaveLength(2);
      expect(collectedFiles.some((file) => file.endsWith(".mp4"))).toBe(true);
      const collectedMarkdown = collectedFiles.find((file) => file.endsWith(".prompt.md"));
      expect(collectedMarkdown).toBeTruthy();
      await expect(readFile(join(collectionContentPath, collectedMarkdown!), "utf8")).resolves.toContain("kind: text/prompt");

      await writeFile(join(collectionContentPath, "manual.png"), Buffer.from(onePixelPngBase64, "base64"));
      const withManual = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json().nodes
        .find((node: { manifest: { id: string } }) => node.manifest.id === collectionNode.manifest.id);
      const manualItem = withManual.items.find((item: { title: string }) => item.title === "manual");
      expect(manualItem).toMatchObject({ type: "image", manual: true, sourceNodeId: "" });
      const deleteManualResponse = await app.inject({
        method: "DELETE",
        url: `/api/libraries/current/collection-nodes/${collectionNode.manifest.id}/items/${encodeURIComponent(manualItem.id)}`
      });
      expect(deleteManualResponse.statusCode).toBe(200);
      expect((await readdir(collectionContentPath)).includes("manual.png")).toBe(false);

      const extractedImageResponse = await app.inject({
        method: "POST",
        url: `/api/libraries/current/collection-nodes/${collectionNode.manifest.id}/items/${encodeURIComponent(collectedImage.id)}/duplicate-node`,
        payload: { x: 900, y: 300, width: 320, height: 240 }
      });
      expect(extractedImageResponse.statusCode).toBe(200);
      const extractedImageBody = extractedImageResponse.json();
      const extractedImage = extractedImageBody.nodes.find((node: { manifest: { id: string; type: string } }) => node.manifest.type === "image" && node.manifest.id !== imageNode.manifest.id);
      const extractedImageEdge = extractedImageBody.canvas.edges.find((edge: { fromNodeId: string; toNodeId: string }) => edge.fromNodeId === collectionNode.manifest.id && edge.toNodeId === extractedImage.manifest.id);
      expect(extractedImageEdge).toBeTruthy();
      expect(extractedImageEdge.kind).toBe("collectionItem");

      const deleteLinkedResponse = await app.inject({
        method: "DELETE",
        url: `/api/libraries/current/collection-nodes/${collectionNode.manifest.id}/items/${encodeURIComponent(collectedImage.id)}`
      });
      expect(deleteLinkedResponse.statusCode).toBe(200);
      expect(deleteLinkedResponse.json().canvas.edges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ fromNodeId: imageNode.manifest.id, toNodeId: collectionNode.manifest.id })
      ]));
      const withoutImage = deleteLinkedResponse.json().nodes
        .find((node: { manifest: { id: string } }) => node.manifest.id === collectionNode.manifest.id);
      expect(withoutImage.items.some((item: { type: string }) => item.type === "image")).toBe(false);
      expect((await readdir(collectionContentPath)).some((file) => file.endsWith(".png"))).toBe(false);

      const textItem = withoutImage.items.find((item: { type: string }) => item.type === "text");
      const extracted = await app.inject({
        method: "POST",
        url: `/api/libraries/current/collection-nodes/${collectionNode.manifest.id}/items/${encodeURIComponent(textItem.id)}/duplicate-node`,
        payload: { x: 1000, y: 500, width: 320, height: 180 }
      });
      expect(extracted.statusCode).toBe(200);
      const extractedText = extracted.json().nodes.find((node: { manifest: { id: string; type: string } }) => node.manifest.type === "text" && node.manifest.id !== textNode.manifest.id);
      expect(extractedText.outputText).toBe("Collection text");
      expect(extractedText.activeStackItem.file).toMatch(/\.prompt\.md$/);
      expect(extracted.json().canvas.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromNodeId: collectionNode.manifest.id, toNodeId: extractedText.manifest.id, kind: "collectionItem" })
      ]));
    } finally {
      await app.close();
    }
  });

  it("adds an explicit local folder as a library projection and detects embedded PNG prompts", async () => {
    const sourcePath = await mkdtemp(join(tmpdir(), "sr-local-source-"));
    await mkdir(join(sourcePath, "images"), { recursive: true });
    await writeFile(join(sourcePath, "snark-library.json"), JSON.stringify({
      schema: "snarkroute-library.v0",
      kind: "library/local-folder",
      id: "robot-children",
      title: "Robot Children",
      defaultView: "image-stack",
      availableViews: ["media-folder", "image-stack", "prompt-library", "workflow"],
      entryWorkflow: "main.orp.json"
    }));
    const embedded = writePngTextChunk(Buffer.from(onePixelPngBase64, "base64"), "snarkroute:prompt", JSON.stringify({
      schema: "snarkroute.prompt-image.v0",
      id: "closeup",
      title: "Robot Closeup",
      category: "characters",
      prompt: "A close portrait.",
      negativePrompt: "blur",
      tags: ["robot"],
      modelHints: ["sdxl"],
      source: { type: "generated-image" }
    }));
    await writeFile(join(sourcePath, "images", "closeup.png"), embedded);
    await writeFile(join(sourcePath, "hero.prompt.png"), embedded);
    await writeFile(join(sourcePath, "main.orp.json"), "{}");

    const app = await testServer();
    try {
      const imported = await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-local-library",
        payload: { sourcePath, dropX: 500, dropY: 300 }
      });
      expect(imported.statusCode).toBe(200);
      const node = imported.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "library");
      expect(node.manifest).toMatchObject({ type: "library", sourcePath, viewMode: "image-stack" });
      expect(node.canvas.nodePath).toBe("nodes/Robot Children.node");
      expect(node.scan).toMatchObject({ title: "Robot Children", defaultView: "image-stack", availableViews: expect.arrayContaining(["image-stack", "prompt-library", "workflow"]) });
      expect(node.scan.assets.find((asset: { relativePath: string }) => asset.relativePath === "images/closeup.png")).toMatchObject({
        kind: "image",
        embeddedPrompt: { title: "Robot Closeup", negativePrompt: "blur" }
      });
      expect(node.scan.assets.find((asset: { relativePath: string }) => asset.relativePath === "hero.prompt.png")).toMatchObject({ kind: "prompt" });

      const switched = await app.inject({
        method: "PUT",
        url: `/api/libraries/current/library-nodes/${node.manifest.id}/view-mode`,
        payload: { viewMode: "prompt-library" }
      });
      expect(switched.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id).manifest.viewMode).toBe("prompt-library");
      const rescanned = await app.inject({ method: "POST", url: `/api/libraries/current/library-nodes/${node.manifest.id}/rescan` });
      expect(rescanned.statusCode).toBe(200);
      const promptAssetId = node.scan.assets.find((asset: { relativePath: string }) => asset.relativePath === "hero.prompt.png").id;
      const deleted = await app.inject({ method: "DELETE", url: `/api/libraries/current/library-nodes/${node.manifest.id}/assets/${promptAssetId}` });
      expect(deleted.statusCode).toBe(200);
      await expect(readFile(join(sourcePath, "hero.prompt.png"))).rejects.toThrow();
      expect(deleted.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id).scan.assets).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ relativePath: "hero.prompt.png" })])
      );
      await rm(sourcePath, { recursive: true, force: true });
      const missingSource = await app.inject({ method: "GET", url: "/api/libraries/current" });
      expect(missingSource.statusCode).toBe(200);
      expect(missingSource.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id).scan.error).toContain("ENOENT");
    } finally {
      await app.close();
    }
  });

  it("imports a video node and supports its local stack workflow", async () => {
    const app = await testServer();
    try {
      const importedResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-video",
        payload: { filename: "Clip.mp4", dataBase64: sampleVideoBase64, dropX: 500, dropY: 300, width: 320, height: 240 }
      });
      expect(importedResponse.statusCode).toBe(200);
      const node = importedResponse.json().nodes[0];
      expect(node.canvas).toMatchObject({ type: "video", x: 340, y: 180, width: 320, height: 240 });
      expect(node.canvas.nodePath).toBe("nodes/Clip.node");
      expect(node.manifest).toMatchObject({ type: "video", activeStackIndex: 0 });
      expect(node.manifest.stack[0]).toMatchObject({ file: "content/000-import.mp4", mimeType: "video/mp4" });

      const promptedResponse = await app.inject({
        method: "PUT",
        url: `/api/libraries/current/video-nodes/${node.manifest.id}/prompt`,
        payload: { prompt: "Animate this slow orbit" }
      });
      const prompted = promptedResponse.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(prompted.manifest.currentPrompt).toBe("Animate this slow orbit");
      await expect(readFile(join(libraryPath, node.canvas.nodePath, "current-prompt.txt"), "utf8")).resolves.toBe("Animate this slow orbit");

      const appendedResponse = await app.inject({
        method: "POST",
        url: `/api/libraries/current/video-nodes/${node.manifest.id}/stack`,
        payload: { filename: "Alternate.webm", dataBase64: sampleVideoBase64 }
      });
      const updated = appendedResponse.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(updated.manifest.activeStackIndex).toBe(1);
      expect(updated.manifest.stack[1]).toMatchObject({ file: "content/000-import.webm", mimeType: "video/webm" });
      await writeFile(join(libraryPath, node.canvas.nodePath, "content", "manual-cut.mov"), Buffer.from(sampleVideoBase64, "base64"));
      const diskRefreshed = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(diskRefreshed.manifest.stack[2]).toMatchObject({ file: "content/manual-cut.mov", mimeType: "video/quicktime" });
      expect(diskRefreshed.manifest.activeStackIndex).toBe(1);

      const previewResponse = await app.inject({
        method: "GET",
        url: `/api/libraries/current/video-nodes/${node.manifest.id}/stack/${updated.manifest.stack[1].id}`
      });
      expect(previewResponse.statusCode).toBe(200);
      expect(previewResponse.headers["content-type"]).toContain("video/webm");

      const duplicateResponse = await app.inject({
        method: "POST",
        url: `/api/libraries/current/video-nodes/${node.manifest.id}/stack/${updated.manifest.stack[1].id}/duplicate-node`,
        payload: { x: 800, y: 300, width: 320, height: 240 }
      });
      const videos = duplicateResponse.json().nodes.filter((entry: { manifest: { type: string } }) => entry.manifest.type === "video");
      expect(videos).toHaveLength(2);
      expect(duplicateResponse.json().canvas.edges).toContainEqual(expect.objectContaining({ fromNodeId: node.manifest.id, toNodeId: videos[1].manifest.id }));
    } finally {
      await app.close();
    }
  });

  it("sends video generation through the selected provider and appends the result", async () => {
    const app = await testServer();
    try {
      const source = await importNode(app, "Source.png");
      const targetResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-video",
        payload: { filename: "Target.mp4", dataBase64: sampleVideoBase64, dropX: 600, dropY: 300, width: 320, height: 240 }
      });
      const target = targetResponse.json().nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "video");
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...canvas, edges: [{ id: "edge_video_image", fromNodeId: source.manifest.id, toNodeId: target.manifest.id }] }
      });
      const generatedPath = join(libraryPath, target.canvas.nodePath, target.manifest.stack[0].file);
      executeRouteMock.mockResolvedValue({
        nodeResults: { generate: { output: { video: { localPath: generatedPath, path: generatedPath, filename: "result.mp4", mimeType: "video/mp4" } } } }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/video-nodes/${target.manifest.id}/generate`,
        payload: {
          modelId: "wan/2.6",
          providerId: "polza",
          prompt: `Animate [[image:${source.manifest.id}]]`,
          parameters: { resolution: "1080p", duration: "10", multi_shots: "false" }
        }
      });

      expect(response.statusCode).toBe(200);
      const generatedNode = response.json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === target.manifest.id);
      expect(generatedNode.manifest.stack[1]).toMatchObject({ file: "content/000-generation.mp4", mimeType: "video/mp4" });
      expect(executeRouteMock).toHaveBeenCalledWith(expect.objectContaining({
        nodes: [expect.objectContaining({
          type: "polza.video.generate",
          params: expect.objectContaining({ model: "wan/2.6", resolution: "1080p", duration: "10", images: expect.any(Array) })
        })]
      }));
    } finally {
      await app.close();
    }
  });

  it("sends only prompt-referenced images to video generation when image chips are present", async () => {
    const app = await testServer();
    try {
      const firstSource = await importNode(app, "First.png");
      const secondSource = await importNode(app, "Second.png");
      const targetResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-video",
        payload: { filename: "Target.mp4", dataBase64: sampleVideoBase64, dropX: 600, dropY: 300, width: 320, height: 240 }
      });
      const target = targetResponse.json().nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "video");
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: {
          ...canvas,
          edges: [
            { id: "edge_video_first_image", fromNodeId: firstSource.manifest.id, toNodeId: target.manifest.id },
            { id: "edge_video_second_image", fromNodeId: secondSource.manifest.id, toNodeId: target.manifest.id }
          ]
        }
      });
      const generatedPath = join(libraryPath, target.canvas.nodePath, target.manifest.stack[0].file);
      executeRouteMock.mockResolvedValue({
        nodeResults: { generate: { output: { video: { localPath: generatedPath, path: generatedPath, filename: "result.mp4", mimeType: "video/mp4" } } } }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/video-nodes/${target.manifest.id}/generate`,
        payload: {
          modelId: "wan/2.6",
          providerId: "polza",
          prompt: `Use [[image:${secondSource.manifest.id}]] as the opening frame`,
          maxImageInputs: 14
        }
      });

      expect(response.statusCode).toBe(200);
      const params = executeRouteMock.mock.calls[0][0].nodes[0].params;
      expect(params.prompt).toBe("Use @image 1 as the opening frame");
      expect(params.images).toHaveLength(1);
      expect(secondSource.manifest.stack[0].file).toBe("content/000-import.png");
      expect(params.images[0].path.replaceAll("\\", "/")).toContain(secondSource.manifest.stack[0].file);
    } finally {
      await app.close();
    }
  });

  it("sends OpenRouter video frame images in the documented content-part shape", async () => {
    const app = await testServer();
    try {
      process.env.OPENROUTER_API_KEY = "sk-openrouter-test";
      const source = await importNode(app, "Source.png");
      const targetResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-video",
        payload: { filename: "Target.mp4", dataBase64: sampleVideoBase64, dropX: 600, dropY: 300, width: 320, height: 240 }
      });
      const target = targetResponse.json().nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "video");
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...canvas, edges: [{ id: "edge_openrouter_video_image", fromNodeId: source.manifest.id, toNodeId: target.manifest.id }] }
      });
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const value = String(url);
        if (value.endsWith("/videos")) return new Response(JSON.stringify({ id: "job-123", status: "pending" }), { status: 202, headers: { "content-type": "application/json" } });
        if (value.endsWith("/videos/job-123")) return new Response(JSON.stringify({ status: "completed", unsigned_urls: ["https://cdn.openrouter.ai/result.mp4"] }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(Buffer.from(sampleVideoBase64, "base64"), { status: 200, headers: { "content-type": "video/mp4" } });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/video-nodes/${target.manifest.id}/generate`,
        payload: {
          modelId: "google/veo-3.1",
          providerId: "openrouter",
          prompt: `Animate [[image:${source.manifest.id}]]`,
          parameters: { resolution: "720p", duration: "8" }
        }
      });

      expect(response.statusCode).toBe(200);
      const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(requestBody.frame_images).toEqual([
        {
          frame_type: "first_frame",
          type: "image_url",
          image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) }
        }
      ]);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it("downloads generated OpenRouter video API assets with authorization", async () => {
    const app = await testServer();
    try {
      process.env.OPENROUTER_API_KEY = "sk-openrouter-test";
      const targetResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/import-video",
        payload: { filename: "Target.mp4", dataBase64: sampleVideoBase64, dropX: 600, dropY: 300, width: 320, height: 240 }
      });
      const target = targetResponse.json().nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "video");
      const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from(sampleVideoBase64, "base64"), { status: 200, headers: { "content-type": "video/mp4" } }));
      vi.stubGlobal("fetch", fetchMock);
      executeRouteMock.mockResolvedValue({
        status: "succeeded",
        nodeResults: {
          generate: {
            status: "succeeded",
            output: { video: { path: "https://openrouter.ai/api/v1/videos/job-123/content?index=0", filename: "result.mp4", mimeType: "video/mp4" } }
          }
        }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/video-nodes/${target.manifest.id}/generate`,
        payload: { modelId: "kwaivgi/kling-video-o1", providerId: "polza", prompt: "Animate" }
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/videos/job-123/content?index=0",
        expect.objectContaining({ headers: { Authorization: "Bearer sk-openrouter-test" } })
      );
      const generated = response.json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === target.manifest.id).manifest.stack[1];
      await expect(readFile(join(libraryPath, target.canvas.nodePath, generated.file))).resolves.toBeInstanceOf(Buffer);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it("persists the current image-node prompt as text in its node folder", async () => {
    const app = await testServer();
    try {
      const target = await importNode(app, "Prompted.png");
      const response = await app.inject({
        method: "PUT",
        url: `/api/libraries/current/image-nodes/${target.manifest.id}/prompt`,
        payload: { prompt: "A quiet lighthouse at dawn" }
      });
      const node = response.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === target.manifest.id);
      expect(node.manifest.currentPrompt).toBe("A quiet lighthouse at dawn");
      await expect(readFile(join(libraryPath, target.canvas.nodePath, "current-prompt.txt"), "utf8")).resolves.toBe("A quiet lighthouse at dawn");
    } finally {
      await app.close();
    }
  });

  it("duplicates a canvas node with its stored content but without route edges", async () => {
    const app = await testServer();
    try {
      const source = await importNode(app, "Source.png");
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/image-nodes/${source.manifest.id}/prompt`,
        payload: { prompt: "Copied prompt" }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/nodes/${source.manifest.id}/duplicate`,
        payload: { x: 420, y: 220 }
      });
      expect(response.statusCode).toBe(200);
      const duplicate = response.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id !== source.manifest.id);
      expect(duplicate.canvas).toMatchObject({ type: "image", x: 420, y: 220 });
      expect(duplicate.manifest).toMatchObject({ type: "image", title: "Source copy", currentPrompt: "Copied prompt" });
      expect(duplicate.canvas.nodePath).toBe("nodes/Source copy.node");
      expect(duplicate.manifest.stack[0]).toMatchObject({ file: "content/000-import.png", mimeType: "image/png" });
      expect(response.json().canvas.edges ?? []).toEqual([]);
      await expect(readFile(join(libraryPath, duplicate.canvas.nodePath, "content", "000-import.png"))).resolves.toBeInstanceOf(Buffer);
    } finally {
      await app.close();
    }
  });

  it("duplicates a canvas node folder as a different representation", async () => {
    const app = await testServer();
    try {
      const source = await importNode(app, "Source.png");
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/image-nodes/${source.manifest.id}/prompt`,
        payload: { prompt: "Copied prompt" }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/nodes/${source.manifest.id}/duplicate-as`,
        payload: { type: "text", x: 420, y: 220, width: 320, height: 180, connectFromNodeId: source.manifest.id }
      });

      expect(response.statusCode).toBe(200);
      const duplicate = response.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id !== source.manifest.id);
      expect(duplicate.canvas).toMatchObject({ type: "text", x: 420, y: 220, width: 320, height: 180 });
      expect(duplicate.manifest).toMatchObject({ type: "text", title: "Source Text", text: "Copied prompt", stackPath: "content" });
      expect(duplicate.canvas.nodePath).toBe("nodes/Source Text.node");
      const representationEdge = response.json().canvas.edges.find((edge: { fromNodeId: string; toNodeId: string }) => edge.fromNodeId === source.manifest.id && edge.toNodeId === duplicate.manifest.id);
      expect(representationEdge).toMatchObject({ kind: "representation" });
      await expect(readFile(join(libraryPath, duplicate.canvas.nodePath, "content", "000-import.png"))).resolves.toBeInstanceOf(Buffer);

      await writeFile(join(libraryPath, source.canvas.nodePath, "content", "001-new-object.txt"), "Fresh source object", "utf8");
      const syncResponse = await app.inject({
        method: "POST",
        url: `/api/libraries/current/edges/${representationEdge.id}/sync-representation`
      });
      expect(syncResponse.statusCode).toBe(200);
      await expect(readFile(join(libraryPath, duplicate.canvas.nodePath, "content", "001-new-object.txt"), "utf8")).resolves.toBe("Fresh source object");
    } finally {
      await app.close();
    }
  });

  it("writes portable generated image metadata for connected image inputs", async () => {
    const app = await testServer();
    try {
      const source = await importNode(app, "Source.png");
      const secondSource = await importNode(app, "Plan.png");
      const targetResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "image", x: 600, y: 300, width: 320, height: 240 }
      });
      const target = targetResponse.json().nodes.find((node: { manifest: { type: string; stack: unknown[] } }) => node.manifest.type === "image" && node.manifest.stack.length === 0);
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...canvas, edges: [
          { id: "edge_input", fromNodeId: source.manifest.id, toNodeId: target.manifest.id },
          { id: "edge_plan", fromNodeId: secondSource.manifest.id, toNodeId: target.manifest.id }
        ] }
      });
      const generatedPath = join(libraryPath, source.canvas.nodePath, source.manifest.stack[0].file);
      executeRouteMock.mockResolvedValue({
        nodeResults: { generate: { output: { image: { localPath: generatedPath, path: generatedPath, filename: "result.png", mimeType: "image/png", width: 1, height: 1 } } } }
      });
      const promptTemplate = `[[image:${source.manifest.id}]] - 360 panorama hall. [[image:${secondSource.manifest.id}]] - hall map.\n\nDraw a 360 panorama from the red cross on the plan`;
      const resolvedPrompt = "@image 1 - 360 panorama hall. @image 2 - hall map.\n\nDraw a 360 panorama from the red cross on the plan";

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/image-nodes/${target.manifest.id}/generate`,
        payload: {
          modelId: "openai/gpt-5-image-mini",
          executionProvider: "polza",
          fallbackAllowed: false,
          prompt: promptTemplate,
          parameters: { aspectRatio: "16:9", imageSize: "1K", outputFormat: "png" }
        }
      });

      expect(response.statusCode).toBe(200);
      const generatedNode = response.json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === target.manifest.id);
      expect(generatedNode.manifest.stack).toHaveLength(1);
      await expect(readFile(join(libraryPath, target.canvas.nodePath, "current-prompt.txt"), "utf8")).resolves.toBe(promptTemplate);
      const storedImage = await readFile(join(libraryPath, target.canvas.nodePath, generatedNode.manifest.stack[0].file));
      const provenance = extractImageProvenance(
        storedImage,
        ".png"
      );
      expect(provenance).toMatchObject({
        schema: "snarkroute.image-metadata.v1",
        kind: "generated-image",
        source: { nodeId: target.manifest.id, outputId: "stack-0" },
        generation: {
          providerId: "polza",
          modelId: "openai/gpt-5-image-mini",
          fallbackAllowed: false,
          prompt: { text: resolvedPrompt, template: promptTemplate },
          parameters: { aspectRatio: "16:9", imageSize: "1K", outputFormat: "png" },
          inputImages: [
            expect.objectContaining({ ref: expect.stringMatching(/^library:\/\/default\//), nodeId: source.manifest.id, mimeType: "image/png", role: "360 panorama hall" }),
            expect.objectContaining({ ref: expect.stringMatching(/^library:\/\/default\//), nodeId: secondSource.manifest.id, mimeType: "image/png", role: "hall map" })
          ]
        }
      });
      const serialized = JSON.stringify(provenance);
      expect(serialized).not.toMatch(/[A-Za-z]:\\/);
      expect(serialized).not.toContain("localPath");
      expect(provenance?.generation.parameters).not.toHaveProperty("prompt");
      expect(provenance?.generation.parameters).not.toHaveProperty("promptTemplate");
      expect(readPngTextChunk(storedImage, "snarkroute:prompt")).toBeNull();
      expect(readPngTextChunk(storedImage, "snarkroute.provenance_json")).toBeNull();
      expect(parsePromptPngFile(storedImage, "generated.png")).toMatchObject({
        prompt: { text: resolvedPrompt, category: "generated", previewImage: "generated.png" }
      });
      expect(executeRouteMock).toHaveBeenCalledWith(expect.objectContaining({
        nodes: [expect.objectContaining({
          type: "polza.image.generate",
          params: expect.objectContaining({ model: "openai/gpt-5-image-mini", executionProvider: "polza", fallbackAllowed: false, prompt: resolvedPrompt })
        })]
      }));
      const route = executeRouteMock.mock.calls[0][0];
      expect(route.nodes[0].params.images).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("resolves inserted text and image chips using input order and model image limits", async () => {
    const app = await testServer();
    try {
      const firstImage = await importNode(app, "First.png");
      const secondImage = await importNode(app, "Second.png");
      const textResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const textNode = textResponse.json().nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "text");
      expect(textNode.canvas.nodePath).toBe("nodes/Text.node");
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/text-nodes/${textNode.manifest.id}`,
        payload: { text: "watercolor light" }
      });
      const ignoredTextResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 150, y: 100, width: 320, height: 180 }
      });
      const ignoredTextNode = ignoredTextResponse.json().nodes.find((node: { manifest: { type: string; text: string } }) => node.manifest.type === "text" && node.manifest.id !== textNode.manifest.id);
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/text-nodes/${ignoredTextNode.manifest.id}`,
        payload: { text: "must not appear" }
      });
      const targetResponse = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "image", x: 600, y: 300, width: 320, height: 240 }
      });
      const target = targetResponse.json().nodes.find((node: { manifest: { type: string; stack: unknown[] } }) => node.manifest.type === "image" && node.manifest.stack.length === 0);
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: {
          ...canvas,
          edges: [
            { id: "edge_first", fromNodeId: firstImage.manifest.id, toNodeId: target.manifest.id },
            { id: "edge_second", fromNodeId: secondImage.manifest.id, toNodeId: target.manifest.id },
            { id: "edge_text", fromNodeId: textNode.manifest.id, toNodeId: target.manifest.id },
            { id: "edge_ignored_text", fromNodeId: ignoredTextNode.manifest.id, toNodeId: target.manifest.id }
          ]
        }
      });
      const generatedPath = join(libraryPath, firstImage.canvas.nodePath, firstImage.manifest.stack[0].file);
      executeRouteMock.mockResolvedValue({
        nodeResults: { generate: { output: { image: { localPath: generatedPath, path: generatedPath, filename: "result.png", mimeType: "image/png", width: 1, height: 1 } } } }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/image-nodes/${target.manifest.id}/generate`,
        payload: {
          modelId: "image-with-references",
          prompt: `Use [[text:${textNode.manifest.id}]] near [[image:${secondImage.manifest.id}]], not [[image:${firstImage.manifest.id}]]`,
          inputNodeIds: [secondImage.manifest.id, firstImage.manifest.id, textNode.manifest.id],
          maxImageInputs: 1,
          imageReferenceSyntax: "@image{index}",
          parameters: { aspectRatio: "1:1", imageSize: "2K", imageResolution: "2K", quality: "standard", outputFormat: "webp" }
        }
      });

      expect(response.statusCode).toBe(200);
      const params = executeRouteMock.mock.calls[0][0].nodes[0].params;
      expect(params.prompt).toBe("Use watercolor light near @image1, not ");
      expect(params.prompt).not.toContain("must not appear");
      expect(params.images).toHaveLength(1);
      expect(params).toMatchObject({ aspectRatio: "1:1", imageSize: "2K", imageResolution: "2K", quality: "standard", outputFormat: "webp" });
      expect(secondImage.manifest.stack[0].file).toBe("content/000-import.png");
      expect(params.images[0].path.replaceAll("\\", "/")).toContain(secondImage.manifest.stack[0].file);
    } finally {
      await app.close();
    }
  });

  it("uses prompt assets and plain text files as a text-node stack", async () => {
    const app = await testServer();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const node = created.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "text");
      const contentPath = join(libraryPath, node.canvas.nodePath, "content");
      await writeFile(join(contentPath, "notes.txt"), "Text file content", "utf8");
      const pngPrompt = writePngTextChunk(Buffer.from(onePixelPngBase64, "base64"), "snarkroute:prompt", JSON.stringify({
        schema: "snarkroute.prompt-image.v0",
        id: "embedded",
        title: "Embedded Prompt",
        category: "text-stack",
        prompt: "Prompt extracted from PNG"
      }));
      await writeFile(join(contentPath, "embedded.png"), pngPrompt);

      const snapshot = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json();
      const textNode = snapshot.nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(textNode.manifest).toMatchObject({ stackPath: "content" });
      expect(textNode.stack).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "Embedded Prompt", text: "Prompt extracted from PNG", previewFile: "content/embedded.png" }),
        expect.objectContaining({ title: "notes", text: "Text file content", source: "text" })
      ]));
      const embedded = textNode.stack.find((item: { title: string }) => item.title === "Embedded Prompt");
      const selected = await app.inject({
        method: "PUT",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/stack/active`,
        payload: { selectedStackItemId: embedded.id }
      });
      const selectedNode = selected.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(selectedNode.outputText).toBe("Prompt extracted from PNG");
      const preview = await app.inject({ method: "GET", url: `/api/libraries/current/text-nodes/${node.manifest.id}/stack/${embedded.id}/preview` });
      expect(preview.statusCode).toBe(200);

      const saved = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/stack`,
        payload: { text: "New reusable prompt" }
      });
      const savedNode = saved.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(savedNode.activeStackItem.text).toBe("New reusable prompt");
      await expect(readFile(join(libraryPath, node.canvas.nodePath, savedNode.activeStackItem.file), "utf8")).resolves.toContain("category: text-stack");
      await writeFile(join(contentPath, "manual-later.txt"), "Manually appended text", "utf8");
      const withManual = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(withManual.stack).toEqual(expect.arrayContaining([expect.objectContaining({ title: "manual later", text: "Manually appended text" })]));
      expect(withManual.activeStackItem.id).toBe(savedNode.activeStackItem.id);

      const duplicated = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/stack/${savedNode.activeStackItem.id}/duplicate-node`,
        payload: { x: 600, y: 300, width: 320, height: 240 }
      });
      const duplicatedText = duplicated.json().nodes.find((entry: { manifest: { id: string; type: string } }) => entry.manifest.type === "text" && entry.manifest.id !== node.manifest.id);
      const sourceAfterDuplicate = duplicated.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(duplicatedText.outputText).toBe("New reusable prompt");
      expect(duplicatedText.canvas.height).toBe(node.canvas.height);
      expect(sourceAfterDuplicate.activeStackItem.id).toBe(savedNode.activeStackItem.id);
      expect(duplicated.json().canvas.edges).toContainEqual(expect.objectContaining({ fromNodeId: node.manifest.id, toNodeId: duplicatedText.manifest.id }));

      const removed = await app.inject({ method: "DELETE", url: `/api/libraries/current/text-nodes/${node.manifest.id}/stack/${embedded.id}` });
      const removedNode = removed.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(removedNode.stack).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: embedded.id })]));

      executeRouteMock.mockResolvedValue({
        status: "succeeded",
        nodeResults: { generate: { status: "succeeded", output: { text: "Generated library text" } } }
      });
      const sourceImage = await importNode(app, "Text context.png");
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...canvas, edges: [{ id: "edge_text_image", fromNodeId: sourceImage.manifest.id, toNodeId: node.manifest.id }] }
      });
      const generated = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/generate`,
        payload: {
          modelId: "text.default",
          prompt: `Draft instruction [[image:${sourceImage.manifest.id}]]`,
          executionProvider: "auto",
          inputNodeIds: [sourceImage.manifest.id],
          imageReferenceSyntax: "reference {index}"
        }
      });
      expect(generated.statusCode).toBe(200);
      expect(generated.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id).activeStackItem.text).toBe("Generated library text");
      expect(executeRouteMock).toHaveBeenCalledWith(expect.objectContaining({
        nodes: [expect.objectContaining({ type: "ai.text", params: expect.objectContaining({ prompt: "Draft instruction reference 1", images: [expect.objectContaining({ mimeType: "image/png" })] }) })]
      }));
    } finally {
      await app.close();
    }
  });

  it("persists text node dialogue mode and normalizes legacy nodes as text mode", async () => {
    const app = await testServer();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const node = created.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "text");
      expect(node.manifest.inputMode).toBe("text");

      const switched = await app.inject({
        method: "PUT",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}`,
        payload: { inputMode: "dialogue" }
      });
      const dialogueNode = switched.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(dialogueNode.manifest.inputMode).toBe("dialogue");
      expect(JSON.parse(await readFile(join(libraryPath, node.canvas.nodePath, "snark.node.json"), "utf8")).inputMode).toBe("dialogue");
    } finally {
      await app.close();
    }
  });

  it("runs a text-node dialogue turn without mutating the text stack", async () => {
    const app = await testServer();
    try {
      const sourceImage = await importNode(app, "Dialogue turn.png");
      const created = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const node = created.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "text");
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...canvas, edges: [{ id: "edge_dialogue_turn_image", fromNodeId: sourceImage.manifest.id, toNodeId: node.manifest.id }] }
      });
      executeRouteMock.mockResolvedValue({
        status: "succeeded",
        nodeResults: { generate: { status: "succeeded", output: { text: "Assistant answer" } } }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/conversation/turn`,
        payload: { modelId: "text.default", prompt: "Hello", executionProvider: "auto", attachments: [{ nodeId: sourceImage.manifest.id }], maxImageInputs: 1 }
      });

      expect(response.statusCode).toBe(200);
      const updated = response.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(updated.stack).toHaveLength(0);
      expect(updated.outputText).toBe(node.manifest.text);
      expect(updated.conversation.messages).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Hello" }, { type: "image" }] },
        { role: "assistant", content: [{ type: "text", text: "Assistant answer" }], model: { modelId: "text.default", providerId: "auto" } }
      ]);
      expect(JSON.parse(await readFile(join(libraryPath, node.canvas.nodePath, "conversation.json"), "utf8")).messages).toHaveLength(2);
      expect(executeRouteMock).toHaveBeenCalledWith(expect.objectContaining({
        nodes: [expect.objectContaining({ type: "ai.text", params: expect.objectContaining({ prompt: "USER:\nHello\n@image 1", images: [expect.objectContaining({ mimeType: "image/png" })] }) })]
      }));
    } finally {
      await app.close();
    }
  });

  it("resolves text input chips before saving dialogue turns and messages", async () => {
    const app = await testServer();
    try {
      const sourceCreated = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const sourceNode = sourceCreated.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "text");
      await app.inject({
        method: "PUT",
        url: `/api/libraries/current/text-nodes/${sourceNode.manifest.id}`,
        payload: { text: "Resolved upstream text" }
      });
      const targetCreated = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 500, y: 100, width: 320, height: 180 }
      });
      const targetNode = targetCreated.json().nodes.find((entry: { manifest: { type: string; id: string } }) => entry.manifest.type === "text" && entry.manifest.id !== sourceNode.manifest.id);
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...canvas, edges: [{ id: "edge_text_dialogue", fromNodeId: sourceNode.manifest.id, toNodeId: targetNode.manifest.id }] }
      });
      executeRouteMock.mockResolvedValue({
        status: "succeeded",
        nodeResults: { generate: { status: "succeeded", output: { text: "Assistant answer" } } }
      });

      const turn = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${targetNode.manifest.id}/conversation/turn`,
        payload: {
          modelId: "text.default",
          prompt: `Use [[text:${sourceNode.manifest.id}]]`,
          executionProvider: "auto",
          inputNodeIds: [sourceNode.manifest.id]
        }
      });
      expect(turn.statusCode).toBe(200);
      let updated = turn.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === targetNode.manifest.id);
      expect(updated.conversation.messages[0].content[0].text).toBe("Use Resolved upstream text");
      expect(updated.conversation.messages[0].content[0].text).not.toContain("[[text:");
      expect(executeRouteMock).toHaveBeenCalledWith(expect.objectContaining({
        nodes: [expect.objectContaining({ type: "ai.text", params: expect.objectContaining({ prompt: "USER:\nUse Resolved upstream text" }) })]
      }));

      const message = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${targetNode.manifest.id}/conversation/message`,
        payload: { role: "user", content: `Note [[text:${sourceNode.manifest.id}]]` }
      });
      expect(message.statusCode).toBe(200);
      updated = message.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === targetNode.manifest.id);
      expect(updated.conversation.messages.at(-1).content[0].text).toBe("Note Resolved upstream text");
      expect(updated.conversation.messages.at(-1).content[0].text).not.toContain("[[text:");
    } finally {
      await app.close();
    }
  });

  it("copies dialogue image attachments into node content with relative paths", async () => {
    const app = await testServer();
    try {
      const image = await importNode(app, "Dialogue source.png");
      const created = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const node = created.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "text");
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...canvas, edges: [{ id: "edge_dialogue_image", fromNodeId: image.manifest.id, toNodeId: node.manifest.id }] }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/conversation/message`,
        payload: { role: "user", content: "Look", attachments: [{ nodeId: image.manifest.id, alt: "source" }] }
      });

      expect(response.statusCode).toBe(200);
      const updated = response.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      const imagePart = updated.conversation.messages[0].content.find((part: { type: string }) => part.type === "image");
      expect(imagePart.file).toMatch(/^content\/att_/);
      expect(imagePart.file).not.toContain(libraryPath);
      await expect(readFile(join(libraryPath, node.canvas.nodePath, imagePart.file))).resolves.toBeInstanceOf(Buffer);
    } finally {
      await app.close();
    }
  });

  it("uses the existing text stack endpoint for dialogue excerpts", async () => {
    const app = await testServer();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const node = created.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "text");
      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/stack`,
        payload: { text: "Selected dialogue excerpt" }
      });
      const updated = response.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id);
      expect(updated.activeStackItem.text).toBe("Selected dialogue excerpt");
      expect(updated.outputText).toBe("Selected dialogue excerpt");
    } finally {
      await app.close();
    }
  });

  it("falls back from a failed Polza text route when fallback is allowed", async () => {
    const app = await testServer();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const node = created.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "text");
      executeRouteMock
        .mockResolvedValueOnce({
          status: "failed",
          nodeResults: { generate: { status: "failed", error: "Polza.ai account has insufficient funds." } }
        })
        .mockResolvedValueOnce({
          status: "succeeded",
          nodeResults: { generate: { status: "succeeded", output: { text: "Generated through fallback" } } }
        });

      const generated = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/generate`,
        payload: {
          modelId: "anthropic/claude-opus-4.8-fast",
          prompt: "Draft a caption",
          executionProvider: "polza",
          fallbackAllowed: true,
          availableExecutionProviders: ["polza", "openrouter"]
        }
      });

      expect(generated.statusCode).toBe(200);
      expect(generated.json().nodes.find((entry: { manifest: { id: string } }) => entry.manifest.id === node.manifest.id).activeStackItem.text).toBe("Generated through fallback");
      expect(executeRouteMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
        nodes: [expect.objectContaining({ type: "polza.text" })]
      }));
      expect(executeRouteMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
        nodes: [expect.objectContaining({ type: "ai.text", params: expect.objectContaining({ executionProvider: "auto", providerMode: "auto" }) })]
      }));
    } finally {
      await app.close();
    }
  });

  it("does not send connected images to text generation unless the prompt references them", async () => {
    const app = await testServer();
    try {
      const sourceImage = await importNode(app, "Hidden context.png");
      const created = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "text", x: 100, y: 100, width: 320, height: 180 }
      });
      const node = created.json().nodes.find((entry: { manifest: { type: string } }) => entry.manifest.type === "text");
      const canvas = (await app.inject({ method: "GET", url: "/api/libraries/current/canvas" })).json();
      await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...canvas, edges: [{ id: "edge_hidden_image", fromNodeId: sourceImage.manifest.id, toNodeId: node.manifest.id }] }
      });
      executeRouteMock.mockResolvedValue({
        status: "succeeded",
        nodeResults: { generate: { status: "succeeded", output: { text: "Generated without hidden image" } } }
      });

      const generated = await app.inject({
        method: "POST",
        url: `/api/libraries/current/text-nodes/${node.manifest.id}/generate`,
        payload: {
          modelId: "text.default",
          prompt: "Describe the idea in words",
          executionProvider: "auto",
          inputNodeIds: [sourceImage.manifest.id]
        }
      });

      expect(generated.statusCode).toBe(200);
      expect(executeRouteMock).toHaveBeenCalledWith(expect.objectContaining({
        nodes: [expect.objectContaining({ type: "ai.text", params: expect.objectContaining({ prompt: "Describe the idea in words", images: [] }) })]
      }));
    } finally {
      await app.close();
    }
  });

  it("returns the provider generation error instead of a missing-output message", async () => {
    const app = await testServer();
    try {
      const target = await importNode(app, "Target.png");
      executeRouteMock.mockResolvedValue({
        status: "failed",
        nodeResults: { generate: { status: "failed", error: "Provider rejected this image request." } }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/image-nodes/${target.manifest.id}/generate`,
        payload: { modelId: "openai/gpt-5-image-mini", providerId: "polza", prompt: "Colorize" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Provider rejected this image request.");
    } finally {
      await app.close();
    }
  });

  it("moves a deleted node directory into the workflow trash", async () => {
    const app = await testServer();
    try {
      const target = await importNode(app, "Disposable.png");
      const originalPath = join(libraryPath, target.canvas.nodePath);
      const response = await app.inject({ method: "DELETE", url: `/api/libraries/current/nodes/${target.manifest.id}` });

      expect(response.statusCode).toBe(200);
      await expect(readFile(join(originalPath, "snark.node.json"), "utf8")).rejects.toThrow();
      const trashFolders = await readdir(join(libraryPath, ".trash", "nodes"));
      expect(trashFolders.some((folder) => folder.startsWith("Disposable.node-"))).toBe(true);

      const undoResponse = await app.inject({
        method: "PUT",
        url: "/api/libraries/current/canvas",
        payload: { ...response.json().canvas, nodes: [target.canvas] }
      });
      expect(undoResponse.statusCode).toBe(200);
      const restored = (await app.inject({ method: "GET", url: "/api/libraries/current" })).json().nodes
        .find((node: { manifest: { id: string } }) => node.manifest.id === target.manifest.id);
      expect(restored.manifest.title).toBe("Disposable");
      await expect(readFile(join(originalPath, "snark.node.json"), "utf8")).resolves.toContain(target.manifest.id);
    } finally {
      await app.close();
    }
  });

  it("keeps node folder names aligned when titles collide or change", async () => {
    const app = await testServer();
    try {
      const first = await importNode(app, "Reference.png");
      const second = await importNode(app, "Reference.png");
      expect(first.canvas.nodePath).toBe("nodes/Reference.node");
      expect(second.manifest.title).toBe("Reference (2)");
      expect(second.canvas.nodePath).toBe("nodes/Reference (2).node");

      const response = await app.inject({
        method: "PUT",
        url: `/api/libraries/current/nodes/${first.manifest.id}/title`,
        payload: { title: "Hero" }
      });
      expect(response.statusCode).toBe(200);
      const renamed = response.json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === first.manifest.id);
      expect(renamed.manifest.title).toBe("Hero");
      expect(renamed.canvas.nodePath).toBe("nodes/Hero.node");
      await expect(readFile(join(libraryPath, "nodes", "Reference.node", "snark.node.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(libraryPath, "nodes", "Hero.node", "content", "000-import.png"))).resolves.toBeInstanceOf(Buffer);
    } finally {
      await app.close();
    }
  });

  it("renames collection nodes together with their folder path", async () => {
    const app = await testServer();
    try {
      const source = await importNode(app, "Reference.png");
      const created = await app.inject({
        method: "POST",
        url: "/api/libraries/current/nodes",
        payload: { type: "collection", x: 700, y: 450, width: 360, height: 280, connectFromNodeId: source.manifest.id }
      });
      expect(created.statusCode).toBe(200);
      const collection = created.json().nodes.find((node: { manifest: { type: string } }) => node.manifest.type === "collection");
      expect(collection.manifest.title).toBe("Collection");
      expect(collection.canvas.nodePath).toBe("nodes/Collection.node");

      const response = await app.inject({
        method: "PUT",
        url: `/api/libraries/current/nodes/${collection.manifest.id}/title`,
        payload: { title: "Итог" }
      });
      expect(response.statusCode).toBe(200);
      const renamed = response.json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === collection.manifest.id);
      expect(renamed.manifest.title).toBe("Итог");
      expect(renamed.canvas.nodePath).toBe("nodes/Итог.node");
      await expect(readFile(join(libraryPath, "nodes", "Collection.node", "snark.node.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(libraryPath, "nodes", "Итог.node", "snark.node.json"), "utf8")).resolves.toContain("\"title\": \"Итог\"");
      await expect(readdir(join(libraryPath, "nodes", "Итог.node", "content"))).resolves.toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("downloads a generated remote image into the node stack and does not send its current image as input", async () => {
    const app = await testServer();
    try {
      const target = await importNode(app, "Target.png");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(Buffer.from(onePixelPngBase64, "base64"), { status: 200, headers: { "content-type": "image/png" } })));
      executeRouteMock.mockResolvedValue({
        status: "succeeded",
        nodeResults: {
          generate: {
            status: "succeeded",
            output: { image: { path: "https://s3.polza.ai/generated/colorized.png", filename: "colorized.png", mimeType: "image/png" } }
          }
        }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/image-nodes/${target.manifest.id}/generate`,
        payload: { modelId: "openai/gpt-5.4-image-2", providerId: "polza", prompt: "Colorize" }
      });

      expect(response.statusCode).toBe(200);
      const generated = response.json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === target.manifest.id).manifest.stack[1];
      expect(generated).toMatchObject({ file: "content/000-generation.png", mimeType: "image/png" });
      expect(generated.externalUrl).toBeUndefined();
      expect(executeRouteMock.mock.calls[0][0].nodes[0].params.images).toEqual([]);
      await expect(readFile(join(libraryPath, target.canvas.nodePath, generated.file))).resolves.toBeInstanceOf(Buffer);

      const previewResponse = await app.inject({
        method: "GET",
        url: `/api/libraries/current/image-nodes/${target.manifest.id}/stack/${generated.id}`
      });
      expect(previewResponse.statusCode).toBe(200);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it("runs a pose canvas action provider exactly once across prepare and complete", async () => {
    await writeCanvasActionManifest(libraryPath, poseCanvasActionManifest());
    const app = await testServer();
    try {
      const source = await importNode(app, "Panorama.png");
      const target = await importNode(app, "Panorama target.png");
      let providerRuns = 0;
      let providerOutput: unknown;
      executeRouteMock.mockImplementation(async (route: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string; fromPort?: string; toPort?: string }> }, options?: { initialNodeOutputs?: Record<string, unknown> }) => {
        const seeded = options?.initialNodeOutputs ?? {};
        const nodeResults: Record<string, { status: "succeeded"; output: unknown }> = {};
        for (const node of route.nodes) {
          if (Object.prototype.hasOwnProperty.call(seeded, node.id)) nodeResults[node.id] = { status: "succeeded", output: seeded[node.id] };
          else if (node.id === "provider") {
            providerRuns += 1;
            const inputId = route.edges.find((edge) => edge.to === "provider")?.from ?? "";
            providerOutput = { image: (nodeResults[inputId]?.output as { value?: unknown })?.value };
            nodeResults.provider = { status: "succeeded", output: providerOutput };
          } else if (node.id === "pause") nodeResults.pause = { status: "succeeded", output: providerOutput };
          else if (node.id === "downstream") nodeResults.downstream = { status: "succeeded", output: providerOutput };
        }
        return { status: "succeeded", nodeResults };
      });

      const prepared = await app.inject({ method: "POST", url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`, payload: { phase: "prepare" } });
      expect(prepared.statusCode).toBe(200);
      expect(executeRouteMock.mock.calls[0][0].nodes.map((node: { id: string }) => node.id)).toEqual(["action__input__image", "provider"]);
      expect(providerRuns).toBe(1);

      const completed = await app.inject({
        method: "POST",
        url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`,
        payload: { phase: "complete", continuationId: prepared.json().continuationId, targetNodeId: target.manifest.id, params: { "pause.yawDegrees": 30, "pause.pitchDegrees": -10, "pause.fovDegrees": 70 } }
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(executeRouteMock.mock.calls[1][1].initialNodeOutputs).toHaveProperty("provider");
      expect(providerRuns).toBe(1);

      const edgePrepared = await app.inject({
        method: "POST",
        url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`,
        payload: { phase: "prepare", reuse: true }
      });
      expect(edgePrepared.statusCode, edgePrepared.body).toBe(200);
      const edgeCompleted = await app.inject({
        method: "POST",
        url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`,
        payload: { phase: "complete", continuationId: edgePrepared.json().continuationId, targetNodeId: target.manifest.id, params: { "pause.yawDegrees": 30, "pause.pitchDegrees": -10, "pause.fovDegrees": 70 } }
      });
      expect(edgeCompleted.statusCode, edgeCompleted.body).toBe(200);
      expect(providerRuns).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("completes a panorama pause action with pose and ordinary parameters", async () => {
    await writeCanvasActionManifest(libraryPath, panoramaCanvasActionManifest());
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);
    let providerRuns = 0;
    let renderedView: unknown;
    let downstreamStrength: unknown;
    let lastRunResult: unknown;
    executor.registerNodeRunner("test.counting-provider", ({ inputs }) => {
      providerRuns += 1;
      return { output: { image: inputs.image } };
    });
    executor.registerNodeRunner("test.downstream", ({ params, inputs }) => {
      renderedView = inputs.image;
      downstreamStrength = params.strength;
      return { output: { image: inputs.image } };
    });
    executeRouteMock.mockImplementation(async (route, options) => {
      lastRunResult = await executor.executeRoute(route, options);
      return lastRunResult;
    });

    const app = await testServer();
    try {
      const source = await importNode(app, "Panorama cycle.png");
      const prepared = await app.inject({ method: "POST", url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.panorama-cycle/run`, payload: { phase: "prepare" } });
      expect(prepared.statusCode).toBe(200);

      const completed = await app.inject({
        method: "POST",
        url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.panorama-cycle/run`,
        payload: { phase: "complete", continuationId: prepared.json().continuationId, params: { "viewer.yaw": 30, "viewer.pitch": -10, "viewer.fov": 70, "downstream.strength": 0.65 } }
      });

      expect(completed.statusCode, completed.body).toBe(200);
      expect(completed.json().nodes.length).toBeGreaterThan(1);
      expect(providerRuns).toBe(1);
      expect(renderedView).toMatchObject({ width: 1, height: 1 });
      expect(downstreamStrength).toBe(0.65);
      expect((lastRunResult as { nodeResults?: { viewer?: { output?: { view?: unknown } } } }).nodeResults?.viewer?.output?.view).toEqual({ yaw: 30, pitch: -10, fov: 70 });
    } finally {
      await app.close();
    }
  });

  it("uses preview source.pause without pose bindings", async () => {
    const manifest = poseCanvasActionManifest();
    manifest.params = [];
    manifest.canvasAction = { enabled: true, dialog: { enabled: true, params: [], preview: [{ kind: "panorama360", source: { pause: "pause" } }] } };
    await writeCanvasActionManifest(libraryPath, manifest);
    const app = await testServer();
    try {
      const source = await importNode(app, "Pause panorama.png");
      executeRouteMock.mockResolvedValue({ status: "succeeded", nodeResults: { action__input__image: { status: "succeeded", output: {} }, provider: { status: "succeeded", output: { image: "https://example.test/panorama.jpg" } } } });
      const prepared = await app.inject({ method: "POST", url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`, payload: { phase: "prepare" } });
      expect(prepared.statusCode).toBe(200);
      expect(executeRouteMock.mock.calls[0][0].nodes.map((node: { id: string }) => node.id)).toEqual(["action__input__image", "provider"]);
      expect(prepared.json().previews).toEqual([{ kind: "panorama360", src: "https://example.test/panorama.jpg" }]);
    } finally {
      await app.close();
    }
  });

  it("returns 410 for an expired canvas action continuation", async () => {
    await writeCanvasActionManifest(libraryPath, poseCanvasActionManifest());
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = await testServer();
    try {
      const source = await importNode(app, "Expired panorama.png");
      executeRouteMock.mockResolvedValue({ status: "succeeded", nodeResults: { action__input__image: { status: "succeeded", output: {} }, provider: { status: "succeeded", output: { image: "https://example.test/panorama.jpg" } } } });
      const prepared = await app.inject({ method: "POST", url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`, payload: { phase: "prepare" } });
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      const completed = await app.inject({ method: "POST", url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`, payload: { phase: "complete", continuationId: prepared.json().continuationId } });
      expect(completed.statusCode).toBe(410);
      expect(completed.json().error).toMatch(/expired/i);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it("returns the failed node detail while completing a canvas action", async () => {
    await writeCanvasActionManifest(libraryPath, poseCanvasActionManifest());
    const app = await testServer();
    try {
      const source = await importNode(app, "Failed panorama.png");
      executeRouteMock
        .mockResolvedValueOnce({ status: "succeeded", nodeResults: { action__input__image: { status: "succeeded", output: {} }, provider: { status: "succeeded", output: { image: "https://example.test/panorama.jpg" } } } })
        .mockResolvedValueOnce({ status: "failed", nodeResults: { downstream: { status: "failed", error: "Upscaler timed out after 30 seconds." } }, logs: [] });
      const prepared = await app.inject({ method: "POST", url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`, payload: { phase: "prepare" } });
      const completed = await app.inject({ method: "POST", url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.pose/run`, payload: { phase: "complete", continuationId: prepared.json().continuationId } });
      expect(completed.statusCode).toBe(400);
      expect(completed.json().error).toContain("Upscaler timed out after 30 seconds.");
    } finally {
      await app.close();
    }
  });

  it("keeps canvas actions without a phase on the legacy immediate-run route", async () => {
    await writeCanvasActionManifest(libraryPath, { ...poseCanvasActionManifest(), id: "test.legacy", canvasAction: { enabled: true } });
    const app = await testServer();
    try {
      const source = await importNode(app, "Legacy action.png");
      executeRouteMock.mockResolvedValue({ status: "succeeded", nodeResults: { action: { status: "succeeded", output: { image: { localPath: join(libraryPath, source.canvas.nodePath, source.manifest.stack[0].file) } } } } });
      const response = await app.inject({ method: "POST", url: `/api/libraries/current/nodes/${source.manifest.id}/canvas-actions/test.legacy/run`, payload: { targetNodeId: source.manifest.id } });
      expect(response.statusCode).toBe(200);
      expect(executeRouteMock.mock.calls[0][0].nodes.map((node: { id: string }) => node.id)).toEqual(["source", "action"]);
    } finally {
      await app.close();
    }
  });
});

async function testServer() {
  const { buildServer } = await import("../src/index");
  return buildServer();
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function importNode(app: Awaited<ReturnType<typeof testServer>>, filename: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/libraries/current/import-image",
    payload: { filename, dataBase64: onePixelPngBase64, dropX: 500, dropY: 300, width: 320, height: 240 }
  });
  return response.json().nodes[response.json().nodes.length - 1];
}

const onePixelPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const sampleVideoBase64 = "AAECAwQ=";

async function writeCanvasActionManifest(libraryPath: string, manifest: Record<string, unknown>) {
  const directory = join(libraryPath, ".test-canvas-actions", String(manifest.id));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
}

function poseCanvasActionManifest() {
  return {
    kind: "snarkroute.node", schemaVersion: "0.1", id: "test.pose", title: "Pose action", version: "0.1.0", author: { name: "Test" }, license: "UNLICENSED", origin: "generated",
    permissions: { network: false, readFiles: false, writeOutputs: false, shell: false, env: [] }, executor: { type: "declarative" },
    inputs: [{ id: "image", type: "image" }], outputs: [{ id: "image", type: "image" }],
    params: [
      { id: "pause.yawDegrees", type: "number", binding: { nodeId: "pause", paramId: "yawDegrees" } },
      { id: "pause.pitchDegrees", type: "number", binding: { nodeId: "pause", paramId: "pitchDegrees" } },
      { id: "pause.fovDegrees", type: "number", binding: { nodeId: "pause", paramId: "fovDegrees" } }
    ],
    canvasAction: { enabled: true, poseBindings: { yaw: "pause.yawDegrees", pitch: "pause.pitchDegrees", fov: "pause.fovDegrees" }, dialog: { enabled: true, params: ["pause.yawDegrees", "pause.pitchDegrees", "pause.fovDegrees"], preview: [{ kind: "panorama360", source: { output: "image" } }] } },
    generatedWith: {
      kind: "compound.subroute", compound: { inputs: [{ id: "image", nodeId: "provider", port: "image" }], outputs: [{ id: "image", nodeId: "downstream", port: "image" }] },
      subroute: { routeVersion: "0.1", route: { id: "pose", title: "Pose", author: { name: "Test" } }, nodes: [{ id: "provider", type: "test.provider" }, { id: "pause", type: "transform.panorama360ToFisheye" }, { id: "downstream", type: "test.downstream" }], edges: [{ from: "provider", to: "pause", fromPort: "image", toPort: "image" }, { from: "pause", to: "downstream", fromPort: "image", toPort: "image" }] }
    }
  };
}

function panoramaCanvasActionManifest() {
  return {
    kind: "snarkroute.node", schemaVersion: "0.1", id: "test.panorama-cycle", title: "Panorama cycle", version: "0.1.0", author: { name: "Test" }, license: "UNLICENSED", origin: "generated",
    permissions: { network: false, readFiles: true, writeOutputs: true, shell: false, env: [] }, executor: { type: "declarative" },
    inputs: [{ id: "image", type: "image" }], outputs: [{ id: "image", type: "image" }],
    params: [
      { id: "viewer.yaw", type: "number", binding: { nodeId: "viewer", paramId: "yaw" } },
      { id: "viewer.pitch", type: "number", binding: { nodeId: "viewer", paramId: "pitch" } },
      { id: "viewer.fov", type: "number", binding: { nodeId: "viewer", paramId: "fov" } },
      { id: "downstream.strength", type: "number", binding: { nodeId: "downstream", paramId: "strength" } }
    ],
    canvasAction: { enabled: true, poseBindings: { yaw: "viewer.yaw", pitch: "viewer.pitch", fov: "viewer.fov" }, dialog: { enabled: true, params: ["viewer.yaw", "viewer.pitch", "viewer.fov", "downstream.strength"], preview: [{ kind: "panorama360", source: { pause: "viewer" } }] } },
    generatedWith: {
      kind: "compound.subroute", compound: { inputs: [{ id: "image", nodeId: "provider", port: "image" }], outputs: [{ id: "image", nodeId: "downstream", port: "image" }] },
      subroute: { routeVersion: "0.1", route: { id: "panorama-cycle", title: "Panorama cycle", author: { name: "Test" } }, nodes: [{ id: "provider", type: "test.counting-provider" }, { id: "viewer", type: "preview.panorama360" }, { id: "downstream", type: "test.downstream" }], edges: [{ from: "provider", to: "viewer", fromPort: "image", toPort: "image" }, { from: "viewer", to: "downstream", fromPort: "image", toPort: "image" }] }
    }
  };
}
