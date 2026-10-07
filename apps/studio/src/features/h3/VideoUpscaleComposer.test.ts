import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildVideoUpscaleQueueRequest, VideoUpscaleComposer } from "./VideoUpscaleComposer";
import { QueueCard } from "./H3QueuePanel";

describe("Video Upscale composer", () => {
  it("exposes the simple flow with collapsed Advanced and scoped verification", () => {
    const html = renderToStaticMarkup(createElement(VideoUpscaleComposer,{ onQueued: async () => {},onClearDraft: () => {} }));
    for (const text of ["Video Upscale", "VimeoScale 2×", "H3 Max / CUDA / 2× tested", "Preserve original", "Local GPU", "Add to Queue", "Advanced settings", "CC-BY-SA-4.0"]) expect(html).toContain(text);
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
  });
  it("serializes an explicit upscale separately from hosted regeneration and H3 generation", () => {
    const request = buildVideoUpscaleQueueRequest({slot:"sourceVideo",kind:"video",path:"/source.mp4",filename:"source.mp4",mimeType:"video/mp4"},{model:"openmodeldb/vimeoscale-unet-x2",scale:2,delivery:[2560,1440]});
    expect(request.operation).toBe("video_upscale");
    expect(request.videoUpscale).toMatchObject({scale:2,delivery:[2560,1440]});
    expect(request).not.toHaveProperty("modelVariant");
    expect(request).not.toHaveProperty("cameraPath");
    const html = renderToStaticMarkup(createElement(QueueCard,{ item:{ ...request,id:"test",operation:"video_upscale",assets:request.assets as any,status:"ready",progress:0,duration:5,aspectRatio:"auto",renderMode:"preview",modelVariant:"h3_base" }, index:0,count:1,busy:false,onLoad:()=>{},onEdit:()=>{},onMutate:async()=>{},onOpenResult:async()=>{},onToggleSelected:async()=>{},onArchive:async()=>{} }));
    expect(html).toContain("Native 2×");
    expect(html).toContain("Delivery 2560×1440");
    expect(html).not.toContain("h3_base");
  });
});
