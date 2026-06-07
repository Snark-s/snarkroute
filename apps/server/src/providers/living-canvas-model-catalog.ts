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
const videoResolutions = parameter("resolution", "Resolution", ["720p", "1080p"], "720p");
const videoDurations = parameter("duration", "Duration", ["5", "10", "15"], "5");
const videoMultiShots = parameter("multi_shots", "Multi-shot", ["false", "true"], "false");
const videoGenerateAudio = parameter("generate_audio", "Sound", ["false", "true"], "true");

export function livingCanvasModelMetadata(modelId: string, providerId: string, contentType?: string): LivingCanvasModelMetadata {
  const id = modelId.toLowerCase();
  if (contentType === "video") {
    if (/(^|\/)(video-)?upscale|upscaler/.test(id)) {
      return { generationParameters: [], maxImageInputs: 1 };
    }
    if (providerId === "polza") {
      return { generationParameters: [videoResolutions, videoDurations, videoMultiShots, ...(supportsVideoAudio(id) ? [videoGenerateAudio] : [])], maxImageInputs: polzaVideoMaxImageInputs(id) };
    }
    return { generationParameters: [] };
  }
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

function supportsVideoAudio(modelId: string): boolean {
  return /(^|\/|[-_])veo-?3/i.test(modelId);
}

function polzaVideoMaxImageInputs(modelId: string): number {
  if (/(^|\/)(video-)?upscale|upscaler|topaz/.test(modelId)) return 1;
  if (/veo[-_]?3/.test(modelId)) return 2;
  if (/seedance/.test(modelId)) return 9;
  if (/wan/.test(modelId)) return 2;
  return 14;
}

function parameter(id: string, label: string, options: string[], defaultValue: string): LivingCanvasParameterDefinition {
  return { id, label, type: "select", default: defaultValue, options: options.map((value) => ({ value })) };
}

function countParameter(): LivingCanvasParameterDefinition {
  return { id: "n", label: "Images", type: "number", default: 1, min: 1, max: 4, step: 1 };
}
