import { createModelIconResolver, type ModelLogo } from "@snarkroute/model-catalog";

export type { ModelLogo };

const apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317";

export const {
  modelLogoFor,
  modelLogoForCatalogOption,
  unknownModelLogoSrc
} = createModelIconResolver(apiBase);
