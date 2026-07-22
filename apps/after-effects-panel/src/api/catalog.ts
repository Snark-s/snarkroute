import type { GenerationModel, GenerationOperation, MediaKind } from "../types";
import { panelCanRepresentModel } from "../inputs/contracts";

export const operationLabels: Record<GenerationOperation, string> = {
  "text-to-image": "Text to image",
  "image-to-image": "Image to image",
  "image-editing": "Image editing",
  inpainting: "Inpainting",
  outpainting: "Outpainting",
  "image-upscale": "Image upscale",
  "text-to-video": "Text to video",
  "image-to-video": "Image to video",
  "video-to-video": "Video to video",
  "audio-conditioned-video": "Audio-conditioned video"
};

export function operationsForModels(models: GenerationModel[]): GenerationOperation[] {
  return (Object.keys(operationLabels) as GenerationOperation[]).filter((operation) => models.some((model) => modelSupportsOperation(model, operation)));
}

export function filterModelsForOperation(models: GenerationModel[], operation: GenerationOperation): GenerationModel[] {
  return models.filter((model) => modelSupportsOperation(model, operation));
}

export function modelSupportsOperation(model: GenerationModel, operation: GenerationOperation): boolean {
  if (!isExecutableByRunner(model) || !panelCanRepresentModel(model)) return false;
  const output = outputMediaTypeForOperation(operation);
  if (!model.outputTypes.includes(output)) return false;
  const hasImageInput = model.inputTypes.includes("image") || Boolean(imageContract(model)) || (model.maximumImageInputs ?? model.requiredImageInputs ?? 0) > 0 || model.runnableWithSuppliedInputs === true;
  const requiresImage = requiredImageInputs(model) > 0;
  const prompt = modelSupportsPrompt(model);
  const imageCapability = model.capabilities.some((capability) => ["image.generate", "image.edit", "image.reference"].includes(capability));
  if (operation === "image-upscale") return model.capabilities.includes("image.upscale") && model.roles.includes("upscaler") && hasImageInput;
  if (model.roles.includes("upscaler")) return false;
  if (operation === "text-to-image") return imageCapability && prompt && !requiresImage && model.roles.includes("generator");
  if (operation === "image-to-image") return imageCapability && hasImageInput;
  if (operation === "image-editing") return model.capabilities.includes("image.edit") && hasImageInput && model.roles.includes("editor");
  if (operation === "inpainting") return model.capabilities.includes("image.edit") && hasImageInput && hasInputRole(model, "mask");
  if (operation === "outpainting") return model.capabilities.includes("image.edit") && hasImageInput && hasInputRole(model, "outpaint");
  if (operation === "text-to-video") return model.capabilities.includes("video.generate") && prompt && !requiresImage;
  if (operation === "image-to-video") return model.capabilities.includes("video.generate") && hasImageInput;
  if (operation === "video-to-video") return model.capabilities.includes("video.generate") && hasMediaInput(model, "video");
  return operation === "audio-conditioned-video" && model.capabilities.includes("video.generate") && hasMediaInput(model, "audio");
}

export function modelSupportsPrompt(model: GenerationModel): boolean {
  return model.inputTypes.includes("text") || model.parameters.some((field) => field.id.toLowerCase() === "prompt");
}

export function requiredImageInputs(model: GenerationModel): number {
  return model.requiredImageInputs ?? imageContract(model)?.minItems ?? (imageContract(model)?.required ? 1 : 0);
}

export function maximumImageInputs(model: GenerationModel): number {
  const metadata = Number(model.metadata?.maxImageInputs);
  return model.maximumImageInputs ?? imageContract(model)?.maxItems ?? (Number.isFinite(metadata) && metadata > 0 ? metadata : 1);
}

export function outputMediaTypeForOperation(operation: GenerationOperation): MediaKind { return operation.includes("video") ? "video" : "image"; }
export function capabilityForOperation(operation: GenerationOperation): string {
  if (operation === "image-upscale") return "image.upscale";
  if (["image-editing", "inpainting", "outpainting"].includes(operation)) return "image.edit";
  return operation.includes("video") ? "video.generate" : "image.generate";
}

export function filterExecutableVideoModels(models: GenerationModel[], operation: "text-to-video" | "image-to-video"): GenerationModel[] { return filterModelsForOperation(models, operation); }
export function countModelFamilies(models: GenerationModel[]): number { return new Set(models.map((model) => model.originVendor || model.providerModelId.split("/", 1)[0] || model.provider)).size; }

function imageContract(model: GenerationModel) { return model.inputContract?.inputs?.find((item) => item.kind === "image"); }
function hasMediaInput(model: GenerationModel, kind: MediaKind) { const input = model.inputContract?.inputs?.find((item) => item.kind === kind); return Boolean(input && (input.maxItems ?? 1) > 0); }
function hasInputRole(model: GenerationModel, role: string) { return [...(model.inputRoles ?? []), ...(imageContract(model)?.roles ?? [])].some((value) => value.toLowerCase().includes(role)); }
export function isExecutableByRunner(model: GenerationModel) { return Boolean(model.nodeType) && model.availability.status === "available" && model.availability.configured !== false; }
export function frontendExclusionReason(model: GenerationModel, operation: GenerationOperation): string | null {
  if (!isExecutableByRunner(model)) return "not executable by runner";
  if (!panelCanRepresentModel(model)) return "required media cannot be materialized";
  if (!model.outputTypes.includes(outputMediaTypeForOperation(operation))) return "wrong output media";
  if (!modelSupportsOperation(model, operation)) return "contract does not match operation";
  return null;
}
