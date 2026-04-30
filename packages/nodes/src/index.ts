import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { NodeRunner, RouteExecutor } from "@snarkroute/executor";

export interface NodeDefinition {
  type: string;
  title: string;
  description: string;
}

export const builtInNodeDefinitions: NodeDefinition[] = [
  { type: "input.text", title: "Text Input", description: "Produces a text value from params.value." },
  { type: "transform.template", title: "Template Transform", description: "Produces text from params.template after route template resolution." },
  { type: "debug.log", title: "Debug Log", description: "Logs a message or value and passes the value through." },
  { type: "output.file", title: "Output File", description: "Writes text or JSON to the local run folder." }
];

export const inputTextRunner: NodeRunner = ({ params }) => ({
  output: {
    text: String(params.value ?? "")
  }
});

export const transformTemplateRunner: NodeRunner = ({ params }) => ({
  output: {
    text: String(params.template ?? "")
  }
});

export const debugLogRunner: NodeRunner = ({ params, context }) => {
  const value = params.value ?? params.message ?? null;
  const message = params.message ? String(params.message) : JSON.stringify(value);
  context.log(message, undefined);
  return {
    output: { value },
    logs: [message]
  };
};

export const outputFileRunner: NodeRunner = async ({ params, inputs, context }) => {
  const filename = sanitizeFilename(basename(String(params.filename ?? "output.json")));
  const from = params.from ?? firstInputValue(inputs) ?? {};
  const path = join(context.outputDirectory, filename);
  const data = typeof from === "string" ? from : JSON.stringify(from, null, 2);
  await writeFile(path, data, "utf8");
  return {
    output: {
      path,
      filename,
      contentPreview: data.length > 500 ? `${data.slice(0, 500)}...` : data
    },
    logs: [`Wrote ${filename}`]
  };
};

export function registerBuiltInNodeRunners(executor: RouteExecutor): void {
  executor.registerNodeRunner("input.text", inputTextRunner);
  executor.registerNodeRunner("transform.template", transformTemplateRunner);
  executor.registerNodeRunner("debug.log", debugLogRunner);
  executor.registerNodeRunner("output.file", outputFileRunner);
}

function firstInputValue(inputs: Record<string, unknown>): unknown {
  const first = Object.values(inputs)[0];
  if (first && typeof first === "object" && "text" in first) return (first as { text: unknown }).text;
  return first;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
