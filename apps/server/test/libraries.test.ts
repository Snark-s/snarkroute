import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractImageProvenance } from "../src/libraries/image-metadata";

const { executeRouteMock } = vi.hoisted(() => ({ executeRouteMock: vi.fn() }));

vi.mock("../src/execution/service", () => ({
  createRouteExecutor: async () => ({ executeRoute: executeRouteMock })
}));

const previousNoListen = process.env.SNARKROUTE_NO_LISTEN;
const previousLibraryPath = process.env.SNARKROUTE_LIBRARY_PATH;

describe("SnarkRoute libraries", () => {
  let libraryPath: string;

  beforeEach(async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    libraryPath = await mkdtemp(join(tmpdir(), "sr-library-"));
    process.env.SNARKROUTE_LIBRARY_PATH = libraryPath;
    executeRouteMock.mockReset();
  });

  afterEach(() => {
    restoreEnv("SNARKROUTE_NO_LISTEN", previousNoListen);
    restoreEnv("SNARKROUTE_LIBRARY_PATH", previousLibraryPath);
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

  it("imports an image as a full Image Node folder with stack[0] copied image", async () => {
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
      expect(node.canvas.nodePath).toMatch(/^image-nodes\/.+\.imgnode$/);
      expect(node.manifest).toMatchObject({ format: "snarkroute.node", type: "image", activeStackIndex: 0 });
      expect(node.manifest.stack[0]).toMatchObject({ file: "stack/000-import.png", source: "import", mimeType: "image/png", width: 1, height: 1 });

      const canvas = JSON.parse(await readFile(join(libraryPath, "canvas.json"), "utf8"));
      expect(canvas.nodes[0].nodePath).toBe(node.canvas.nodePath);
      expect(canvas.nodes[0].nodePath).not.toContain("\\");
      expect(canvas.nodes[0].nodePath).not.toContain(libraryPath);

      const nodeFolders = await readdir(join(libraryPath, "image-nodes"));
      const nodeManifest = JSON.parse(await readFile(join(libraryPath, "image-nodes", nodeFolders[0], "snark.node.json"), "utf8"));
      expect(nodeManifest.stack[0].file).toBe("stack/000-import.png");
      await expect(readFile(join(libraryPath, "image-nodes", nodeFolders[0], "current-prompt.txt"), "utf8")).resolves.toBe("");
      expect(body.manifest.representativeImage).toEqual({ nodeId: node.manifest.id, stackItemId: node.manifest.stack[0].id });
      await expect(readFile(join(libraryPath, "image-nodes", nodeFolders[0], "stack", "000-import.png"))).resolves.toBeInstanceOf(Buffer);
    } finally {
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

  it("sends the selected image model and connected image inputs through generation", async () => {
    const app = await testServer();
    try {
      const source = await importNode(app, "Source.png");
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
        payload: { ...canvas, edges: [{ id: "edge_input", fromNodeId: source.manifest.id, toNodeId: target.manifest.id }] }
      });
      const generatedPath = join(libraryPath, source.canvas.nodePath, source.manifest.stack[0].file);
      executeRouteMock.mockResolvedValue({
        nodeResults: { generate: { output: { image: { localPath: generatedPath, path: generatedPath, filename: "result.png", mimeType: "image/png", width: 1, height: 1 } } } }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/libraries/current/image-nodes/${target.manifest.id}/generate`,
        payload: { modelId: "openai/gpt-5-image-mini", providerId: "polza", prompt: "Combine references" }
      });

      expect(response.statusCode).toBe(200);
      const generatedNode = response.json().nodes.find((node: { manifest: { id: string } }) => node.manifest.id === target.manifest.id);
      expect(generatedNode.manifest.stack).toHaveLength(1);
      await expect(readFile(join(libraryPath, target.canvas.nodePath, "current-prompt.txt"), "utf8")).resolves.toBe("Combine references");
      const provenance = extractImageProvenance(
        await readFile(join(libraryPath, target.canvas.nodePath, generatedNode.manifest.stack[0].file)),
        ".png"
      );
      expect(provenance).toMatchObject({
        format: "snarkroute.image-provenance",
        version: "0.1",
        prompt: "Combine references",
        providerId: "polza",
        modelId: "openai/gpt-5-image-mini",
        parameters: { aspectRatio: "16:9", imageSize: "1K", outputFormat: "png" }
      });
      expect(executeRouteMock).toHaveBeenCalledWith(expect.objectContaining({
        nodes: [expect.objectContaining({
          type: "polza.image.generate",
          params: expect.objectContaining({ model: "openai/gpt-5-image-mini", prompt: "Combine references" })
        })]
      }));
      const route = executeRouteMock.mock.calls[0][0];
      expect(route.nodes[0].params.images).toHaveLength(1);
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
      expect(params.images[0].path).toContain(secondImage.manifest.stack[0].file.replace("/", "\\"));
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

  it("keeps a generated remote image URL in the node stack when no local copy is available", async () => {
    const app = await testServer();
    try {
      const target = await importNode(app, "Target.png");
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
      expect(generated).toMatchObject({ externalUrl: "https://s3.polza.ai/generated/colorized.png", mimeType: "image/png" });

      const previewResponse = await app.inject({
        method: "GET",
        url: `/api/libraries/current/image-nodes/${target.manifest.id}/stack/${generated.id}`
      });
      expect(previewResponse.statusCode).toBe(302);
      expect(previewResponse.headers.location).toBe("https://s3.polza.ai/generated/colorized.png");
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
