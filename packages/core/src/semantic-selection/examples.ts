import { EngineRequirementBuilder } from "./index";

/** Provider-independent smoke examples. They intentionally stop at semantic
 * requirements; a registry and gateway policy choose the concrete engine. */
export async function semanticSelectionExamples() {
  const builder = new EngineRequirementBuilder();
  const [referenceVideoEdit, firstLastFrameVideo, imageUpscale] = await Promise.all([
    builder.build({
      targetDomain: "video",
      inputs: { text: true, videoCount: 1, imageCount: 2, imageRoles: ["reference"] },
      prompt: "Replace the actor with the referenced character while preserving the shot"
    }),
    builder.build({
      targetDomain: "video",
      inputs: { text: true, imageCount: 2, imageRoles: ["firstFrame", "lastFrame"] },
      prompt: "Animate this image, ending on the other supplied frame"
    }),
    builder.build({
      targetDomain: "upscale",
      explicitOperation: "upscale",
      inputs: { imageCount: 1 },
      constraints: { scale: 4 }
    })
  ]);

  return { referenceVideoEdit, firstLastFrameVideo, imageUpscale };
}
