import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import {
  appendImageToNodeStack,
  appendVideoToNodeStack,
  canvasNodeFolderPath,
  createImageStackReadStream,
  createVideoStackReadStream,
  createLocalLibraryAssetReadStream,
  duplicateCanvasNode,
  createEmptyCanvasNode,
  createLibrary,
  deleteCanvasEdge,
  deleteCanvasNode,
  deleteImageNodeStackItem,
  deleteVideoNodeStackItem,
  duplicateStackItemAsConnectedImageNode,
  duplicateStackItemAsConnectedVideoNode,
  generateImageNodeStackItem,
  generateVideoNodeStackItem,
  getCurrentLibrarySnapshot,
  importImageAsNode,
  importVideoAsNode,
  importLocalLibraryAsNode,
  openLibrary,
  renameCanvasNode,
  readCanvas,
  readImageNode,
  readLibraryNode,
  readVideoNode,
  setImageNodeActiveStackItem,
  setVideoNodeActiveStackItem,
  updateLibraryNodeViewMode,
  updateImageNodePrompt,
  updateMediaNodeRouteSettings,
  updateVideoNodePrompt,
  updateTextNode,
  writeCanvas,
  type LibraryContentKind,
  type LibraryDefaultView,
  type LibraryKind,
  type ImageGenerationSettings,
  type LibraryViewMode,
  type SnarkCanvasDocument
} from "../libraries/service";
import { errorMessage } from "../services/errors";

export async function registerLibraryRoutes(app: FastifyInstance) {
  app.get("/api/libraries/current", async (_request, reply) => {
    try {
      return await getCurrentLibrarySnapshot();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { path?: string; title?: string; libraryKind?: LibraryKind; contentKind?: LibraryContentKind; defaultView?: LibraryDefaultView } }>("/api/libraries/create", async (request, reply) => {
    try {
      return await createLibrary({
        path: request.body?.path,
        title: request.body?.title,
        libraryKind: request.body?.libraryKind,
        contentKind: request.body?.contentKind,
        defaultView: request.body?.defaultView
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { path?: string } }>("/api/libraries/open", async (request, reply) => {
    try {
      if (!request.body?.path) return reply.code(400).send({ error: "path is required." });
      return await openLibrary(request.body.path);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/libraries/current/canvas", async (_request, reply) => {
    try {
      const snapshot = await getCurrentLibrarySnapshot();
      return snapshot.canvas;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: SnarkCanvasDocument }>("/api/libraries/current/canvas", async (request, reply) => {
    try {
      const snapshot = await getCurrentLibrarySnapshot();
      if (!snapshot.manifest.canvas) return reply.code(400).send({ error: "Current library does not have a canvas." });
      return await writeCanvas(snapshot.path, request.body);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/libraries/current/nested", async (_request, reply) => {
    try {
      return { nestedLibraries: (await getCurrentLibrarySnapshot()).nestedLibraries };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { filename?: string; dataBase64?: string; dropX?: number; dropY?: number; width?: number; height?: number } }>("/api/libraries/current/import-image", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      return await importImageAsNode({
        filename: request.body.filename,
        dataBase64: request.body.dataBase64,
        dropX: Number(request.body.dropX ?? 0),
        dropY: Number(request.body.dropY ?? 0),
        width: request.body.width,
        height: request.body.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { filename?: string; dataBase64?: string; dropX?: number; dropY?: number; width?: number; height?: number } }>("/api/libraries/current/import-video", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      return await importVideoAsNode({
        filename: request.body.filename,
        dataBase64: request.body.dataBase64,
        dropX: Number(request.body.dropX ?? 0),
        dropY: Number(request.body.dropY ?? 0),
        width: request.body.width,
        height: request.body.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { sourcePath?: string; viewMode?: LibraryViewMode; dropX?: number; dropY?: number; width?: number; height?: number } }>("/api/libraries/current/import-local-library", async (request, reply) => {
    try {
      if (!request.body?.sourcePath) return reply.code(400).send({ error: "sourcePath is required." });
      return await importLocalLibraryAsNode({
        sourcePath: request.body.sourcePath,
        viewMode: request.body.viewMode,
        dropX: Number(request.body.dropX ?? 0),
        dropY: Number(request.body.dropY ?? 0),
        width: request.body.width,
        height: request.body.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { type?: "image" | "video" | "text"; x?: number; y?: number; width?: number; height?: number; connectFromNodeId?: string } }>("/api/libraries/current/nodes", async (request, reply) => {
    try {
      if (request.body?.type !== "image" && request.body?.type !== "video" && request.body?.type !== "text") return reply.code(400).send({ error: "type must be image, video, or text." });
      return await createEmptyCanvasNode({
        type: request.body.type,
        x: Number(request.body.x ?? 0),
        y: Number(request.body.y ?? 0),
        width: request.body.width,
        height: request.body.height,
        connectFromNodeId: request.body.connectFromNodeId
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { nodeId: string } }>("/api/libraries/current/image-nodes/:nodeId", async (request, reply) => {
    try {
      return await readImageNode(request.params.nodeId);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { x?: number; y?: number } }>("/api/libraries/current/nodes/:nodeId/duplicate", async (request, reply) => {
    try {
      return await duplicateCanvasNode({
        nodeId: request.params.nodeId,
        x: Number(request.body?.x ?? 0),
        y: Number(request.body?.y ?? 0)
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string } }>("/api/libraries/current/nodes/:nodeId/open-folder", async (request, reply) => {
    try {
      const path = await canvasNodeFolderPath(request.params.nodeId);
      const child = spawn("explorer.exe", [path], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { nodeId: string } }>("/api/libraries/current/video-nodes/:nodeId", async (request, reply) => {
    try {
      return await readVideoNode(request.params.nodeId);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { filename?: string; dataBase64?: string } }>("/api/libraries/current/image-nodes/:nodeId/stack", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      return await appendImageToNodeStack({
        nodeId: request.params.nodeId,
        filename: request.body.filename,
        dataBase64: request.body.dataBase64
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { filename?: string; dataBase64?: string } }>("/api/libraries/current/video-nodes/:nodeId/stack", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      return await appendVideoToNodeStack({ nodeId: request.params.nodeId, filename: request.body.filename, dataBase64: request.body.dataBase64 });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { activeStackIndex?: number } }>("/api/libraries/current/image-nodes/:nodeId/stack/active", async (request, reply) => {
    try {
      return await setImageNodeActiveStackItem(request.params.nodeId, Number(request.body?.activeStackIndex ?? 0));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string; stackItemId: string }; Body: { x?: number; y?: number; width?: number; height?: number } }>("/api/libraries/current/image-nodes/:nodeId/stack/:stackItemId/duplicate-node", async (request, reply) => {
    try {
      return await duplicateStackItemAsConnectedImageNode({
        nodeId: request.params.nodeId,
        stackItemId: request.params.stackItemId,
        x: Number(request.body?.x ?? 0),
        y: Number(request.body?.y ?? 0),
        width: request.body?.width,
        height: request.body?.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string; stackItemId: string }; Body: { x?: number; y?: number; width?: number; height?: number } }>("/api/libraries/current/video-nodes/:nodeId/stack/:stackItemId/duplicate-node", async (request, reply) => {
    try {
      return await duplicateStackItemAsConnectedVideoNode({
        nodeId: request.params.nodeId,
        stackItemId: request.params.stackItemId,
        x: Number(request.body?.x ?? 0),
        y: Number(request.body?.y ?? 0),
        width: request.body?.width,
        height: request.body?.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { nodeId: string; stackItemId: string } }>("/api/libraries/current/image-nodes/:nodeId/stack/:stackItemId", async (request, reply) => {
    try {
      return await deleteImageNodeStackItem(request.params.nodeId, request.params.stackItemId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { modelId?: string; prompt?: string; providerId?: string; executionProvider?: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; inputNodeIds?: string[]; maxImageInputs?: number; imageReferenceSyntax?: string; parameters?: ImageGenerationSettings } }>("/api/libraries/current/image-nodes/:nodeId/generate", async (request, reply) => {
    try {
      if (!request.body?.modelId) return reply.code(400).send({ error: "modelId is required." });
      return await generateImageNodeStackItem({
        nodeId: request.params.nodeId,
        modelId: request.body.modelId,
        prompt: request.body.prompt,
        providerId: request.body.providerId,
        executionProvider: request.body.executionProvider,
        fallbackAllowed: request.body.fallbackAllowed,
        availableExecutionProviders: request.body.availableExecutionProviders,
        inputNodeIds: request.body.inputNodeIds,
        maxImageInputs: request.body.maxImageInputs,
        imageReferenceSyntax: request.body.imageReferenceSyntax,
        parameters: request.body.parameters
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { modelId?: string; prompt?: string; providerId?: string; executionProvider?: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; inputNodeIds?: string[]; maxImageInputs?: number; imageReferenceSyntax?: string; parameters?: ImageGenerationSettings } }>("/api/libraries/current/video-nodes/:nodeId/generate", async (request, reply) => {
    try {
      if (!request.body?.modelId) return reply.code(400).send({ error: "modelId is required." });
      return await generateVideoNodeStackItem({
        nodeId: request.params.nodeId,
        modelId: request.body.modelId,
        prompt: request.body.prompt,
        providerId: request.body.providerId,
        executionProvider: request.body.executionProvider,
        fallbackAllowed: request.body.fallbackAllowed,
        availableExecutionProviders: request.body.availableExecutionProviders,
        inputNodeIds: request.body.inputNodeIds,
        maxImageInputs: request.body.maxImageInputs,
        imageReferenceSyntax: request.body.imageReferenceSyntax,
        parameters: request.body.parameters
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { prompt?: string } }>("/api/libraries/current/image-nodes/:nodeId/prompt", async (request, reply) => {
    try {
      return await updateImageNodePrompt(request.params.nodeId, request.body?.prompt ?? "");
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { prompt?: string } }>("/api/libraries/current/video-nodes/:nodeId/prompt", async (request, reply) => {
    try {
      return await updateVideoNodePrompt(request.params.nodeId, request.body?.prompt ?? "");
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { type: "image" | "video"; nodeId: string }; Body: { modelId?: string; executionProvider?: string; fallbackAllowed?: boolean } }>("/api/libraries/current/:type-nodes/:nodeId/route-settings", async (request, reply) => {
    try {
      if (request.params.type !== "image" && request.params.type !== "video") return reply.code(404).send({ error: "Media node type not found." });
      if (!request.body?.modelId) return reply.code(400).send({ error: "modelId is required." });
      return await updateMediaNodeRouteSettings(request.params.type, request.params.nodeId, {
        modelId: request.body.modelId,
        executionProvider: request.body.executionProvider,
        fallbackAllowed: request.body.fallbackAllowed
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { nodeId: string; stackItemId: string } }>("/api/libraries/current/video-nodes/:nodeId/stack/:stackItemId", async (request, reply) => {
    try {
      return await deleteVideoNodeStackItem(request.params.nodeId, request.params.stackItemId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { activeStackIndex?: number } }>("/api/libraries/current/video-nodes/:nodeId/stack/active", async (request, reply) => {
    try {
      return await setVideoNodeActiveStackItem(request.params.nodeId, Number(request.body?.activeStackIndex ?? 0));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { text?: string; color?: string } }>("/api/libraries/current/text-nodes/:nodeId", async (request, reply) => {
    try {
      return await updateTextNode(request.params.nodeId, { text: request.body?.text, color: request.body?.color });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { nodeId: string } }>("/api/libraries/current/nodes/:nodeId", async (request, reply) => {
    try {
      return await deleteCanvasNode(request.params.nodeId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { title?: string } }>("/api/libraries/current/nodes/:nodeId/title", async (request, reply) => {
    try {
      return await renameCanvasNode(request.params.nodeId, request.body?.title ?? "");
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { edgeId: string } }>("/api/libraries/current/edges/:edgeId", async (request, reply) => {
    try {
      return await deleteCanvasEdge(request.params.edgeId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { nodeId: string; stackItemId: string } }>("/api/libraries/current/image-nodes/:nodeId/stack/:stackItemId", async (request, reply) => {
    try {
      const image = await createImageStackReadStream(request.params.nodeId, request.params.stackItemId);
      if (image.remoteUrl) return reply.redirect(image.remoteUrl);
      reply.header("Content-Type", image.mimeType);
      return reply.send(image.stream);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { viewMode?: LibraryViewMode } }>("/api/libraries/current/library-nodes/:nodeId/view-mode", async (request, reply) => {
    try {
      if (!request.body?.viewMode) return reply.code(400).send({ error: "viewMode is required." });
      return await updateLibraryNodeViewMode(request.params.nodeId, request.body.viewMode);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string } }>("/api/libraries/current/library-nodes/:nodeId/rescan", async (request, reply) => {
    try {
      await readLibraryNode(request.params.nodeId);
      return await getCurrentLibrarySnapshot();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { nodeId: string; stackItemId: string } }>("/api/libraries/current/video-nodes/:nodeId/stack/:stackItemId", async (request, reply) => {
    try {
      const video = await createVideoStackReadStream(request.params.nodeId, request.params.stackItemId);
      reply.header("Content-Type", video.mimeType);
      return reply.send(video.stream);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { nodeId: string; assetId: string } }>("/api/libraries/current/library-nodes/:nodeId/assets/:assetId", async (request, reply) => {
    try {
      const asset = await createLocalLibraryAssetReadStream(request.params.nodeId, request.params.assetId);
      reply.header("Content-Type", asset.mimeType);
      return reply.send(asset.stream);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });
}
