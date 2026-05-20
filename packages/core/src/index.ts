import type { SnarkNodeManifest } from "@snarkroute/nodes";

export * from "./living-canvas";
export {
  GatewayModelResolver,
  ModelGateway,
  ModelRegistry,
  providerModelRef
} from "./model-gateway";
export type {
  ModelCapability,
  ModelInfo,
  ModelInvokeRequest,
  ModelInvokeResult,
  ModelProviderId,
  ModelSelectionPreferences,
  ProviderAdapter,
  ProviderConnection
} from "./model-gateway";
export * from "@snarkroute/protocol";

export type { SnarkNodeManifest };

// Compatibility aliases for product/UI language only. Serialized route and
// package formats remain node-based (`nodes`, `nodePackage`, `.snarknode`).
export type SnarkNodePackageManifest = SnarkNodeManifest;
export type BlockManifest = SnarkNodeManifest;
export type BlockPackageManifest = SnarkNodePackageManifest;
