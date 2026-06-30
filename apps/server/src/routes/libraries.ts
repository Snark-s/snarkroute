import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import {
  appendImageToNodeStack,
  appendAudioToNodeStack,
  appendTextNodeConversationMessage,
  appendTextToNodeStack,
  appendVideoToNodeStack,
  createAudioStackReadStream,
  createCollectionItemReadStream,
  canvasNodeFolderPath,
  createImageStackReadStream,
  createTextNodeConversationImageReadStream,
  createTextStackPreviewReadStream,
  createVideoStackReadStream,
  createLocalLibraryAssetReadStream,
  duplicateCanvasNode,
  duplicateCanvasNodeAsRepresentation,
  createEmptyCanvasNode,
  duplicateCollectionItemAsNode,
  createLibrary,
  deleteCanvasEdge,
  deleteCanvasNode,
  deleteCollectionNodeItem,
  deleteImageNodeStackItem,
  deleteAudioNodeStackItem,
  deleteLocalLibraryAsset,
  deleteTextNodeStackItem,
  deleteVideoNodeStackItem,
  duplicateStackItemAsConnectedImageNode,
  duplicateStackItemAsConnectedAudioNode,
  duplicateStackItemAsTextNode,
  duplicateStackItemAsConnectedVideoNode,
  generateAudioNodeStackItem,
  generateImageNodeStackItem,
  generateTextNodeStackItem,
  runTextNodeConversationTurn,
  generateVideoNodeStackItem,
  addLibraryProject,
  createProjectCoverReadStream,
  createProjectImageReadStream,
  getCurrentLibrarySnapshot,
  importImageAsNode,
  importAudioAsNode,
  importTextAsNode,
  importVideoAsNode,
  importLocalFolderStackAsNode,
  importLocalLibraryAsNode,
  listLibraryProjects,
  listLibraryProjectImages,
  openLibrary,
  openLibraryProject,
  renameCanvasNode,
  readCanvas,
  readImageNode,
  readAudioNode,
  readLibraryNode,
  runCanvasNodeAction,
  scanLocalLibrary,
  removeLibraryProject,
  readVideoNode,
  setAudioNodeActiveStackItem,
  setImageNodeActiveStackItem,
  setImageNodeSelectedStackItems,
  setTextNodeActiveStackItem,
  setVideoNodeActiveStackItem,
  setLibraryProjectCover,
  syncRepresentationEdge,
  trashOrphanCanvasNodeFolders,
  updateLibraryNodeViewMode,
  updateImageNodePrompt,
  updateAudioNodePrompt,
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
  app.get("/api/libraries/projects", async (_request, reply) => {
    try {
      return await listLibraryProjects();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/libraries/projects/pick-folder", async (_request, reply) => {
    try {
      const path = await pickProjectFolder();
      return { path };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { path?: string } }>("/api/libraries/projects/add", async (request, reply) => {
    try {
      if (!request.body?.path) return reply.code(400).send({ error: "path is required." });
      return await addLibraryProject(request.body.path);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { path?: string } }>("/api/libraries/projects/open", async (request, reply) => {
    try {
      if (!request.body?.path) return reply.code(400).send({ error: "path is required." });
      return await openLibraryProject(request.body.path);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { path?: string } }>("/api/libraries/projects/remove", async (request, reply) => {
    try {
      if (!request.body?.path) return reply.code(400).send({ error: "path is required." });
      return await removeLibraryProject(request.body.path);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { path?: string } }>("/api/libraries/projects/open-folder", async (request, reply) => {
    try {
      if (!request.body?.path) return reply.code(400).send({ error: "path is required." });
      const child = spawn("explorer.exe", [request.body.path], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { projectId: string } }>("/api/libraries/projects/:projectId/cover", async (request, reply) => {
    try {
      const cover = await createProjectCoverReadStream(request.params.projectId);
      reply.header("Content-Type", cover.mimeType);
      reply.header("Cache-Control", "no-store");
      return reply.send(cover.stream);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { projectId: string } }>("/api/libraries/projects/:projectId/images", async (request, reply) => {
    try {
      return await listLibraryProjectImages(request.params.projectId);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { projectId: string; imageId: string } }>("/api/libraries/projects/:projectId/images/:imageId", async (request, reply) => {
    try {
      const image = await createProjectImageReadStream(request.params.projectId, request.params.imageId);
      reply.header("Content-Type", image.mimeType);
      reply.header("Cache-Control", "no-store");
      return reply.send(image.stream);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { projectId: string }; Body: { imageId?: string } }>("/api/libraries/projects/:projectId/cover", async (request, reply) => {
    try {
      if (!request.body?.imageId) return reply.code(400).send({ error: "imageId is required." });
      return await setLibraryProjectCover(request.params.projectId, request.body.imageId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

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

  app.post<{ Body: { filename?: string; dataBase64?: string; dropX?: number; dropY?: number; width?: number; height?: number; connectFromNodeId?: string; crop?: { sourceNodeId: string; rect: { x: number; y: number; width: number; height: number }; aspectRatio?: number | null } } }>("/api/libraries/current/import-image", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      return await importImageAsNode({
        filename: request.body.filename,
        dataBase64: request.body.dataBase64,
        dropX: Number(request.body.dropX ?? 0),
        dropY: Number(request.body.dropY ?? 0),
        width: request.body.width,
        height: request.body.height,
        connectFromNodeId: request.body.connectFromNodeId,
        crop: request.body.crop
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

  app.post<{ Body: { filename?: string; dataBase64?: string; dropX?: number; dropY?: number; width?: number; height?: number } }>("/api/libraries/current/import-audio", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      return await importAudioAsNode({
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

  app.post<{ Body: { filename?: string; text?: string; dropX?: number; dropY?: number; width?: number; height?: number } }>("/api/libraries/current/import-text", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.text?.trim()) return reply.code(400).send({ error: "text is required." });
      return await importTextAsNode({
        filename: request.body.filename,
        text: request.body.text,
        dropX: Number(request.body.dropX ?? 0),
        dropY: Number(request.body.dropY ?? 0),
        width: request.body.width,
        height: request.body.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { sourcePath?: string } }>("/api/libraries/scan-local-library", async (request, reply) => {
    try {
      if (!request.body?.sourcePath) return reply.code(400).send({ error: "sourcePath is required." });
      return await scanLocalLibrary(request.body.sourcePath);
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

  app.post<{ Body: { sourcePath?: string; stackKind?: "image" | "text" | "video" | "audio"; dropX?: number; dropY?: number; width?: number; height?: number } }>("/api/libraries/current/import-local-folder-stack", async (request, reply) => {
    try {
      if (!request.body?.sourcePath) return reply.code(400).send({ error: "sourcePath is required." });
      if (request.body.stackKind !== "image" && request.body.stackKind !== "text" && request.body.stackKind !== "video" && request.body.stackKind !== "audio") return reply.code(400).send({ error: "stackKind must be image, text, video, or audio." });
      return await importLocalFolderStackAsNode({
        sourcePath: request.body.sourcePath,
        stackKind: request.body.stackKind,
        dropX: Number(request.body.dropX ?? 0),
        dropY: Number(request.body.dropY ?? 0),
        width: request.body.width,
        height: request.body.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { type?: "image" | "video" | "audio" | "text" | "collection"; variant?: "note"; x?: number; y?: number; width?: number; height?: number; connectFromNodeId?: string } }>("/api/libraries/current/nodes", async (request, reply) => {
    try {
      if (request.body?.type !== "image" && request.body?.type !== "video" && request.body?.type !== "audio" && request.body?.type !== "text" && request.body?.type !== "collection") return reply.code(400).send({ error: "type must be image, video, audio, text, or collection." });
      if (request.body.variant !== undefined && (request.body.type !== "text" || request.body.variant !== "note")) return reply.code(400).send({ error: "variant note is only supported for text nodes." });
      return await createEmptyCanvasNode({
        type: request.body.type,
        variant: request.body.variant,
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

  app.post<{ Params: { nodeId: string; actionId: string }; Body: { targetNodeId?: string; params?: Record<string, unknown>; x?: number; y?: number; width?: number; height?: number } }>("/api/libraries/current/nodes/:nodeId/canvas-actions/:actionId/run", async (request, reply) => {
    try {
      return await runCanvasNodeAction({
        nodeId: request.params.nodeId,
        actionId: request.params.actionId,
        targetNodeId: request.body?.targetNodeId,
        params: request.body?.params && typeof request.body.params === "object" && !Array.isArray(request.body.params) ? request.body.params : undefined,
        x: request.body?.x,
        y: request.body?.y,
        width: request.body?.width,
        height: request.body?.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { type?: "image" | "video" | "audio" | "text"; x?: number; y?: number; width?: number; height?: number; connectFromNodeId?: string } }>("/api/libraries/current/nodes/:nodeId/duplicate-as", async (request, reply) => {
    try {
      if (request.body?.type !== "image" && request.body?.type !== "video" && request.body?.type !== "audio" && request.body?.type !== "text") return reply.code(400).send({ error: "type must be image, video, audio, or text." });
      return await duplicateCanvasNodeAsRepresentation({
        nodeId: request.params.nodeId,
        type: request.body.type,
        x: Number(request.body?.x ?? 0),
        y: Number(request.body?.y ?? 0),
        width: request.body?.width,
        height: request.body?.height,
        connectFromNodeId: request.body?.connectFromNodeId
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

  app.get<{ Params: { nodeId: string } }>("/api/libraries/current/audio-nodes/:nodeId", async (request, reply) => {
    try {
      return await readAudioNode(request.params.nodeId);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { filename?: string; dataBase64?: string; crop?: { sourceNodeId: string; rect: { x: number; y: number; width: number; height: number }; aspectRatio?: number | null } } }>("/api/libraries/current/image-nodes/:nodeId/stack", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      return await appendImageToNodeStack({
        nodeId: request.params.nodeId,
        filename: request.body.filename,
        dataBase64: request.body.dataBase64,
        crop: request.body.crop
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

  app.post<{ Params: { nodeId: string }; Body: { filename?: string; dataBase64?: string } }>("/api/libraries/current/audio-nodes/:nodeId/stack", async (request, reply) => {
    try {
      if (!request.body?.filename) return reply.code(400).send({ error: "filename is required." });
      if (!request.body.dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      return await appendAudioToNodeStack({ nodeId: request.params.nodeId, filename: request.body.filename, dataBase64: request.body.dataBase64 });
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

  app.post<{ Params: { nodeId: string; itemId: string }; Body: { x?: number; y?: number; width?: number; height?: number } }>("/api/libraries/current/collection-nodes/:nodeId/items/:itemId/duplicate-node", async (request, reply) => {
    try {
      return await duplicateCollectionItemAsNode({
        nodeId: request.params.nodeId,
        itemId: request.params.itemId,
        x: Number(request.body?.x ?? 0),
        y: Number(request.body?.y ?? 0),
        width: request.body?.width,
        height: request.body?.height
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { nodeId: string; itemId: string } }>("/api/libraries/current/collection-nodes/:nodeId/items/:itemId", async (request, reply) => {
    try {
      return await deleteCollectionNodeItem(request.params.nodeId, request.params.itemId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { selectedStackItemIds?: string[] } }>("/api/libraries/current/image-nodes/:nodeId/stack/selected", async (request, reply) => {
    try {
      const selectedStackItemIds = request.body?.selectedStackItemIds;
      if (!Array.isArray(selectedStackItemIds) || !selectedStackItemIds.every((id) => typeof id === "string")) {
        return reply.code(400).send({ error: "selectedStackItemIds must be an array of strings." });
      }
      return await setImageNodeSelectedStackItems(request.params.nodeId, selectedStackItemIds);
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

  app.post<{ Params: { nodeId: string; stackItemId: string }; Body: { x?: number; y?: number; width?: number; height?: number } }>("/api/libraries/current/audio-nodes/:nodeId/stack/:stackItemId/duplicate-node", async (request, reply) => {
    try {
      return await duplicateStackItemAsConnectedAudioNode({
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

  app.post<{ Params: { nodeId: string }; Body: { modelId?: string; prompt?: string; providerId?: string; executionProvider?: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; inputNodeIds?: string[]; maxImageInputs?: number; imageReferenceSyntax?: string; parameters?: ImageGenerationSettings } }>("/api/libraries/current/audio-nodes/:nodeId/generate", async (request, reply) => {
    try {
      if (!request.body?.modelId) return reply.code(400).send({ error: "modelId is required." });
      return await generateAudioNodeStackItem({
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

  app.put<{ Params: { nodeId: string }; Body: { prompt?: string } }>("/api/libraries/current/audio-nodes/:nodeId/prompt", async (request, reply) => {
    try {
      return await updateAudioNodePrompt(request.params.nodeId, request.body?.prompt ?? "");
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { type: "image" | "video" | "audio"; nodeId: string }; Body: { modelId?: string; executionProvider?: string; fallbackAllowed?: boolean } }>("/api/libraries/current/:type-nodes/:nodeId/route-settings", async (request, reply) => {
    try {
      if (request.params.type !== "image" && request.params.type !== "video" && request.params.type !== "audio") return reply.code(404).send({ error: "Media node type not found." });
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

  app.delete<{ Params: { nodeId: string; stackItemId: string } }>("/api/libraries/current/audio-nodes/:nodeId/stack/:stackItemId", async (request, reply) => {
    try {
      return await deleteAudioNodeStackItem(request.params.nodeId, request.params.stackItemId);
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

  app.put<{ Params: { nodeId: string }; Body: { activeStackIndex?: number } }>("/api/libraries/current/audio-nodes/:nodeId/stack/active", async (request, reply) => {
    try {
      return await setAudioNodeActiveStackItem(request.params.nodeId, Number(request.body?.activeStackIndex ?? 0));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { text?: string; color?: string; inputMode?: "text" | "dialogue"; modelId?: string; executionProvider?: string; fallbackAllowed?: boolean } }>("/api/libraries/current/text-nodes/:nodeId", async (request, reply) => {
    try {
      if (request.body?.inputMode !== undefined && request.body.inputMode !== "text" && request.body.inputMode !== "dialogue") return reply.code(400).send({ error: "inputMode must be text or dialogue." });
      return await updateTextNode(request.params.nodeId, {
        text: request.body?.text,
        color: request.body?.color,
        inputMode: request.body?.inputMode,
        modelId: request.body?.modelId,
        executionProvider: request.body?.executionProvider,
        fallbackAllowed: request.body?.fallbackAllowed
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { text?: string; title?: string } }>("/api/libraries/current/text-nodes/:nodeId/stack", async (request, reply) => {
    try {
      return await appendTextToNodeStack(request.params.nodeId, request.body?.text ?? "", request.body?.title);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { nodeId: string }; Body: { selectedStackItemId?: string | null } }>("/api/libraries/current/text-nodes/:nodeId/stack/active", async (request, reply) => {
    try {
      return await setTextNodeActiveStackItem(request.params.nodeId, request.body?.selectedStackItemId ?? null);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string; stackItemId: string }; Body: { x?: number; y?: number; width?: number; height?: number } }>("/api/libraries/current/text-nodes/:nodeId/stack/:stackItemId/duplicate-node", async (request, reply) => {
    try {
      return await duplicateStackItemAsTextNode({
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

  app.delete<{ Params: { nodeId: string; stackItemId: string } }>("/api/libraries/current/text-nodes/:nodeId/stack/:stackItemId", async (request, reply) => {
    try {
      return await deleteTextNodeStackItem(request.params.nodeId, request.params.stackItemId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { modelId?: string; prompt?: string; providerId?: string; executionProvider?: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; inputNodeIds?: string[]; maxImageInputs?: number; imageReferenceSyntax?: string } }>("/api/libraries/current/text-nodes/:nodeId/generate", async (request, reply) => {
    try {
      if (!request.body?.modelId) return reply.code(400).send({ error: "modelId is required." });
      return await generateTextNodeStackItem({
        nodeId: request.params.nodeId,
        modelId: request.body.modelId,
        prompt: request.body.prompt,
        providerId: request.body.providerId,
        executionProvider: request.body.executionProvider,
        fallbackAllowed: request.body.fallbackAllowed,
        availableExecutionProviders: request.body.availableExecutionProviders,
        inputNodeIds: request.body.inputNodeIds,
        maxImageInputs: request.body.maxImageInputs,
        imageReferenceSyntax: request.body.imageReferenceSyntax
      });
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

  app.post<{ Params: { nodeId: string }; Body: { role?: "user" | "system"; content?: string; attachments?: Array<{ nodeId?: string; file?: string; alt?: string }> } }>("/api/libraries/current/text-nodes/:nodeId/conversation/message", async (request, reply) => {
    try {
      if (request.body?.role !== "user" && request.body?.role !== "system") return reply.code(400).send({ error: "role must be user or system." });
      return await appendTextNodeConversationMessage({
        nodeId: request.params.nodeId,
        role: request.body.role,
        content: request.body.content,
        attachments: request.body.attachments
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { nodeId: string }; Body: { modelId?: string; prompt?: string; providerId?: string; executionProvider?: string; fallbackAllowed?: boolean; availableExecutionProviders?: string[]; inputNodeIds?: string[]; maxImageInputs?: number; imageReferenceSyntax?: string; attachments?: Array<{ nodeId?: string; file?: string; alt?: string }> } }>("/api/libraries/current/text-nodes/:nodeId/conversation/turn", async (request, reply) => {
    try {
      if (!request.body?.modelId) return reply.code(400).send({ error: "modelId is required." });
      return await runTextNodeConversationTurn({
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
        attachments: request.body.attachments
      });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/libraries/current/nodes/trash-orphans", async (_request, reply) => {
    try {
      return await trashOrphanCanvasNodeFolders();
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

  app.post<{ Params: { edgeId: string } }>("/api/libraries/current/edges/:edgeId/sync-representation", async (request, reply) => {
    try {
      return await syncRepresentationEdge(request.params.edgeId);
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

  app.get<{ Params: { nodeId: string; stackItemId: string } }>("/api/libraries/current/audio-nodes/:nodeId/stack/:stackItemId", async (request, reply) => {
    try {
      const audio = await createAudioStackReadStream(request.params.nodeId, request.params.stackItemId);
      reply.header("Content-Type", audio.mimeType);
      return reply.send(audio.stream);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { nodeId: string; stackItemId: string } }>("/api/libraries/current/text-nodes/:nodeId/stack/:stackItemId/preview", async (request, reply) => {
    try {
      const preview = await createTextStackPreviewReadStream(request.params.nodeId, request.params.stackItemId);
      reply.header("Content-Type", preview.mimeType);
      return reply.send(preview.stream);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { nodeId: string; itemId: string } }>("/api/libraries/current/collection-nodes/:nodeId/items/:itemId/content", async (request, reply) => {
    try {
      const item = await createCollectionItemReadStream(request.params.nodeId, request.params.itemId);
      reply.header("Content-Type", item.mimeType);
      return reply.send(item.stream);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { nodeId: string }; Querystring: { file?: string } }>("/api/libraries/current/text-nodes/:nodeId/conversation/image", async (request, reply) => {
    try {
      if (!request.query.file) return reply.code(400).send({ error: "file is required." });
      const image = await createTextNodeConversationImageReadStream(request.params.nodeId, request.query.file);
      reply.type(image.mimeType);
      return reply.send(image.stream);
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

  app.delete<{ Params: { nodeId: string; assetId: string } }>("/api/libraries/current/library-nodes/:nodeId/assets/:assetId", async (request, reply) => {
    try {
      return await deleteLocalLibraryAsset(request.params.nodeId, request.params.assetId);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

async function pickProjectFolder(): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new Error("Folder picker is only available on Windows in the local server.");
  }
  const command = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8;",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
    "$dialog.Description = 'Select SnarkRoute project folder';",
    "$dialog.ShowNewFolderButton = $true;",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }"
  ].join(" ");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", command], { windowsHide: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code && code !== 0) reject(new Error(stderr.trim() || `Folder picker exited with code ${code}.`));
      else resolve(stdout.trim());
    });
  });
  return output || null;
}
