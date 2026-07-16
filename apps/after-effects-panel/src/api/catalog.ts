import type { VideoModel } from "../types";

export function filterExecutableVideoModels(models: VideoModel[], operation: "text-to-video" | "image-to-video"): VideoModel[] {
  return models.filter((model) =>
    model.nodeType === "polza.video.generate" &&
    model.capabilities.includes("video.generate") &&
    model.outputTypes.includes("video") &&
    model.roles.includes("generator") &&
    !model.roles.includes("upscaler") &&
    model.availability.status === "available" &&
    model.availability.configured !== false &&
    (operation === "text-to-video" || model.runnableWithSuppliedInputs !== false)
  );
}

export function countModelFamilies(models: VideoModel[]): number {
  return new Set(models.map((model) => model.providerModelId.includes("/") ? model.providerModelId.split("/", 1)[0] : model.providerModelId.split(/[-_.]/, 1)[0] || "unknown")).size;
}
