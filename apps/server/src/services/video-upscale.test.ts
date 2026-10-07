import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { H3QueueBlockedError, H3QueueService, type H3QueueRuntime } from "./h3-queue";
import { createProductionVideoUpscaleNodeRunner, normalizeVideoUpscale, videoUpscaleCatalog } from "./video-upscale";

describe("production Video Upscale", () => {
  it("routes Model Gateway through the contained runner and retains full provenance", async () => {
    const runner = createProductionVideoUpscaleNodeRunner(async (item,_directory,progress) => {
      expect(item.videoUpscale).toMatchObject({model:"openmodeldb/vimeoscale-unet-x2",device:"cuda",chunk_size:3,delivery:[2560,1440]});
      expect(item.assets).toMatchObject([{slot:"sourceVideo",path:"/input.mp4"}]);
      await progress(.5,"inference");
      return {workerJobId:"mock",resultPaths:["/output.mp4"],metadata:{provider:"local",model:"openmodeldb/vimeoscale-unet-x2",provenance:{source_sha256:"source",model_sha256:"model",output_sha256:"output",model_scale:2,temporal_context:3,delivery_resolution:[2560,1440],native_resolution:[2688,1536],fps:24,frames:124,shutdown:{classification:"CLEAN"}}}};
    });
    const result = await runner({node:{id:"upscale",type:"local_video_upscale",params:{}},params:{delivery:[2560,1440]},inputs:{video:{path:"/input.mp4",mimeType:"video/mp4"}},context:{runId:"mock",route:{} as never,outputDirectory:"/tmp",nodeOutputs:{},log:()=>{}}});
    expect(result.output).toMatchObject({provider:"local_video_upscale",video:{width:2560,height:1440}});
    expect(result.provenance).toMatchObject({source_sha256:"source",model_sha256:"model",output_sha256:"output",shutdown:{classification:"CLEAN"}});
  });
  it("defaults to the exact Vimeo profile and rejects CPU fallback", async () => {
    expect(normalizeVideoUpscale()).toMatchObject({ model: "openmodeldb/vimeoscale-unet-x2", scale: 2, context: 3, chunk_size: 3, overlap_frames: 1, device: "cuda", audio_handling: "copy", crf: 18, preset: "medium", gop: 48 });
    expect(() => normalizeVideoUpscale({ device: "auto" })).toThrow("CUDA");
    expect(() => normalizeVideoUpscale({ device: "cpu" })).toThrow("CUDA");
    const catalog = await videoUpscaleCatalog();
    expect(catalog.models.find(m => m.id.includes("vimeoscale"))).toMatchObject({ group: "Production", license: "CC-BY-SA-4.0" });
    expect(catalog.models.find(m => m.id.includes("purephoto"))).toMatchObject({ group: "Experimental" });
    expect(catalog.models.find(m => m.id.includes("gameup"))).toMatchObject({ group: "Experimental", commercial_use: false, license: "CC-BY-NC-SA-4.0", verification: "Unverified" });
  });

  it("round trips settings and provenance in the existing queue, with resource blocked state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "video-upscale-queue-"));
    const runtime: H3QueueRuntime = {
      acquire: async () => ({ workerUrl: "", serviceToken: "" }),
      render: async () => { throw new H3QueueBlockedError("Blocked by resources: insufficient VRAM"); },
      cleanup: async () => undefined
    };
    try {
      const service = new H3QueueService({ directory, runtime });
      await service.create({ title: "Video Upscale", operation: "video_upscale", prompt: "", videoUpscale: { delivery: [2560,1440] }, assets: [{ slot: "sourceVideo", kind: "video", path: "/source.mp4", filename: "source.mp4", mimeType: "video/mp4" }] });
      const restored = await new H3QueueService({ directory, runtime }).getState();
      expect(restored.items[0].videoUpscale).toMatchObject({ scale: 2, delivery: [2560,1440] });
      await service.start("saved_worker");
      expect((await service.waitForSettled()).items[0]).toMatchObject({ status: "blocked", error: expect.stringContaining("resources") });
      runtime.render = async () => ({ workerJobId: "vup_test", resultPaths: ["/out.mp4"], metadata: { provider: "local", model: "openmodeldb/vimeoscale-unet-x2", provenance: { source_sha256: "source", output_sha256: "output", native_resolution: [2688,1536], delivery_resolution: [2560,1440], shutdown: { classification: "DELAYED_CLEAN" } } } });
      await service.start("saved_worker");
      await service.waitForSettled();
      const result = (await new H3QueueService({ directory, runtime }).getState()).items[0];
      expect(result.resultMetadata?.provenance).toMatchObject({ output_sha256: "output", shutdown: { classification: "DELAYED_CLEAN" } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
