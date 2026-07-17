import type { ParameterDefinition } from "../types";
import { modelParameterValidationReasonsV1, normalizeModelParameterValuesV1 } from "@snarkroute/model-catalog";

export function gatewayParameters(schema: ParameterDefinition[], values: Record<string, unknown>): Record<string, unknown> {
  return normalizeModelParameterValuesV1(schema, values);
}

export function parameterValidationReasons(schema: ParameterDefinition[], values: Record<string, unknown>): string[] {
  return modelParameterValidationReasonsV1(schema, values);
}

export function parameterDiagnostics(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, /api[_-]?key|token|secret|password/i.test(key) ? "[redacted]" : value]));
}
