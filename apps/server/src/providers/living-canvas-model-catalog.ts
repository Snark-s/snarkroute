export interface LivingCanvasParameterDefinition {
  id: string;
  label: string;
  type: "select" | "number" | "text";
  default?: string | number | boolean;
  options?: Array<{ value: string; label?: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface LivingCanvasModelMetadata {
  generationParameters: LivingCanvasParameterDefinition[];
  defaultParameters?: Record<string, string | number | boolean>;
  maxImageInputs?: number;
  imageReferenceSyntax?: string;
}

const aspectRatios = parameter("aspectRatio", "Aspect ratio", ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"], "1:1");
const aspectRatiosWithAuto = parameter("aspectRatio", "Aspect ratio", ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"], "auto");
const resolutions = parameter("imageResolution", "Resolution", ["1K", "2K", "4K"], "2K");
const imageSizes = parameter("imageSize", "Resolution", ["1K", "2K", "4K"], "2K");
const qualities = parameter("quality", "Quality", ["draft", "standard", "high"], "high");
const outputFormats = parameter("outputFormat", "Format", ["png", "jpg", "webp"], "png");

export function livingCanvasModelMetadata(modelId: string, providerId: string): LivingCanvasModelMetadata {
  const id = modelId.toLowerCase();
  if (/(^|\/)(image-)?upscale|upscaler/.test(id)) {
    return { generationParameters: [], maxImageInputs: 1 };
  }
  if (providerId === "polza" && id === "openai/gpt-5.4-image-2") {
    return { generationParameters: [aspectRatiosWithAuto, countParameter()] };
  }
  if (providerId === "polza" && id === "openai/gpt-image-1.5") {
    return {
      generationParameters: [
        parameter("aspectRatio", "Aspect ratio", ["1:1", "2:3", "3:2"], "1:1"),
        parameter("quality", "Quality", ["low", "medium", "high"], "medium")
      ]
    };
  }
  if (providerId === "polza" && (id === "openai/gpt-5-image" || id === "openai/gpt-5-image-mini")) {
    return { generationParameters: [] };
  }
  if (providerId === "polza") {
    return { generationParameters: [aspectRatios, resolutions, qualities, outputFormats, countParameter()] };
  }
  if (providerId === "gemini" || id.includes("gemini") || id.includes("nano-banana")) {
    return { generationParameters: [aspectRatios, imageSizes] };
  }
  return { generationParameters: [] };
}

function parameter(id: string, label: string, options: string[], defaultValue: string): LivingCanvasParameterDefinition {
  return { id, label, type: "select", default: defaultValue, options: options.map((value) => ({ value })) };
}

function countParameter(): LivingCanvasParameterDefinition {
  return { id: "n", label: "Images", type: "number", default: 1, min: 1, max: 4, step: 1 };
}
