import {
  createModelIconResolver,
  modelLogoRegistry,
  type ModelLogo
} from "@snarkroute/model-catalog";

export type { ModelLogo };
export { modelLogoRegistry };

const apiBase = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL || "http://127.0.0.1:4317";

export const {
  modelLogoFor,
  modelLogoForCatalogOption,
  unknownModelLogoSrc
} = createModelIconResolver(apiBase);
