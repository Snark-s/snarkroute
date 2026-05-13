import { builtInNodeManifests, type SnarkNodeManifest } from "@snarkroute/nodes";
import { isGeminiEnabled, isReplicateEnabled } from "../services/env";
export function providerNodeManifests(): SnarkNodeManifest[] {
  return [
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "ai.text",
      title: "Text AI",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Text",
      description: "Runs remote text models through OpenRouter by default, with Direct mode in Advanced.",
      enabled: true,
      permissions: { network: true, networkHosts: ["openrouter.ai", "generativelanguage.googleapis.com"], readFiles: false, writeOutputs: false, shell: false, env: ["OPENROUTER_API_KEY", "GEMINI_API_KEY"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "ai.text" },
      inputs: [{ id: "prompt", type: "text", required: false, label: "Prompt" }, { id: "systemPrompt", type: "text", required: false, label: "System" }],
      outputs: [{ id: "text", type: "text", label: "Text" }, { id: "output", type: "json", label: "JSON" }],
      params: [
        { id: "model", type: "text", label: "Model", default: "text.default" },
        { id: "providerMode", type: "text", label: "Provider Mode", default: "auto" },
        { id: "prompt", type: "text", label: "Prompt", default: "" },
        { id: "systemPrompt", type: "text", label: "System Prompt", default: "" }
      ]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "ai.image.generate",
      title: "Image Generation",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Image Processing",
      description: "Task-based image generation with explicit model selection and transparent connection routing.",
      enabled: true,
      permissions: { network: true, networkHosts: ["openrouter.ai", "generativelanguage.googleapis.com"], readFiles: true, writeOutputs: true, shell: false, env: ["OPENROUTER_API_KEY", "GEMINI_API_KEY"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "ai.image.generate" },
      inputs: [{ id: "images", type: "image", required: false, label: "Images" }, { id: "prompt", type: "text", required: false, label: "Prompt" }],
      outputs: [{ id: "image", type: "image", label: "Image" }, { id: "output", type: "json", label: "JSON" }],
      params: [
        { id: "model", type: "text", label: "Model", default: "image.nano-banana" },
        { id: "providerMode", type: "text", label: "Connection Route", default: "auto" },
        { id: "prompt", type: "text", label: "Prompt", default: "Create a polished image." },
        { id: "aspectRatio", type: "text", label: "Aspect Ratio", default: "1:1" },
        { id: "imageSize", type: "text", label: "Quality", default: "2K" }
      ]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "replicate.model",
      title: "Replicate Model",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Image Processing",
      description: "Runs a Replicate model prediction.",
      enabled: isReplicateEnabled(),
      permissions: { network: true, networkHosts: ["api.replicate.com"], readFiles: true, writeOutputs: false, shell: false, env: ["REPLICATE_API_TOKEN"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "replicate.model" },
      inputs: [{ id: "input", type: "json", required: false, label: "Input" }],
      outputs: [{ id: "output", type: "data", label: "Output" }],
      params: [{ id: "model", type: "text", label: "Model" }]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "replicate.clarity-upscaler",
      title: "Clarity Upscaler",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Image Processing",
      description: "Runs Replicate philz1337x/clarity-upscaler.",
      enabled: isReplicateEnabled(),
      permissions: { network: true, networkHosts: ["api.replicate.com"], readFiles: true, writeOutputs: true, shell: false, env: ["REPLICATE_API_TOKEN"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "replicate.clarity-upscaler" },
      inputs: [{ id: "image", type: "image", required: true, label: "Image" }, { id: "prompt", type: "text", required: false, label: "Prompt" }],
      outputs: [{ id: "image", type: "image", label: "Image" }]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "gemini.llm",
      title: "Gemini LLM",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Text",
      description: "Runs Gemini text generation.",
      enabled: isGeminiEnabled(),
      permissions: { network: true, networkHosts: ["generativelanguage.googleapis.com"], readFiles: false, writeOutputs: false, shell: false, env: ["GEMINI_API_KEY"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "gemini.llm" },
      inputs: [{ id: "prompt", type: "text", required: false, label: "Prompt" }, { id: "systemPrompt", type: "text", required: false, label: "System" }],
      outputs: [{ id: "text", type: "text", label: "Text" }]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "gemini.nano-banana-2",
      title: "Nano Banana 2",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Image Processing",
      description: "Runs Gemini image generation/editing.",
      enabled: isGeminiEnabled(),
      permissions: { network: true, networkHosts: ["generativelanguage.googleapis.com"], readFiles: true, writeOutputs: true, shell: false, env: ["GEMINI_API_KEY"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "gemini.nano-banana-2" },
      inputs: [{ id: "prompt", type: "text", required: false, label: "Prompt" }, { id: "images", type: "image", required: false, label: "Images" }],
      outputs: [{ id: "image", type: "image", label: "Image" }]
    }
  ];
}

export function allReservedNodeIds(installed: SnarkNodeManifest[]): string[] {
  return [...builtInNodeManifests, ...providerNodeManifests(), ...installed].map((manifest) => manifest.id);
}