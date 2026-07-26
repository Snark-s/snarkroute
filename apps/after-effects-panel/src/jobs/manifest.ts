import type { GenerationMetadata } from "../types";
export function serializeGenerationManifest(metadata: GenerationMetadata): string { return `${JSON.stringify(metadata, null, 2)}\n`; }
