import { parameterSemanticIdV1 } from "@snarkroute/model-catalog";
import type { CompositionSnapshot, ParameterDefinition } from "../types";

const standardRatios = [
  { value: "1:1", ratio: 1 },
  { value: "16:9", ratio: 16 / 9 },
  { value: "9:16", ratio: 9 / 16 }
] as const;

export function compositionAspectRatio(width: number, height: number): string | undefined {
  if (!(width > 0 && height > 0)) return undefined;
  const actual = width / height;
  return standardRatios.find((candidate) => Math.abs(actual - candidate.ratio) / candidate.ratio <= 0.01)?.value;
}

export function applyCompositionAspectRatioDefault(
  schema: ParameterDefinition[],
  values: Record<string, unknown>,
  composition: Pick<CompositionSnapshot, "width" | "height"> | null
): Record<string, unknown> {
  if (!composition) return values;
  const field = schema.find((candidate) => parameterSemanticIdV1(candidate.id) === "aspectratio");
  if (!field || values[field.id] !== "" && values[field.id] !== undefined && values[field.id] !== null) return values;
  const ratio = compositionAspectRatio(composition.width, composition.height);
  if (!ratio || field.options?.length && !field.options.some((option) => option.value === ratio)) return values;
  return { ...values, [field.id]: ratio };
}
