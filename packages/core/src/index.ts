import type { SnarkNodeManifest } from "@snarkroute/nodes";

export * from "./living-canvas";
export * from "./decision-layer";
export * from "./decision-layer/example";
export * from "./decision-shadow";
export * from "./semantic-selection";
export * from "./semantic-selection/examples";
export {
  GatewayModelResolver,
  ModelGateway,
  ModelRegistry,
  estimateCatalogPricingQuote,
  estimatePricingCatalogQuote,
  failedProviderConnection,
  isPricingCatalogFresh,
  providerModelRef,
  sanitizePricingQuote,
  unsupportedProviderConnection,
  verifiedProviderConnection,
  unknownPricingQuote
} from "./model-gateway";
export type {
  ModelGatewayQuoteResult,
  ModelCapability,
  EngineAvailability,
  EngineKind,
  ModelInfo,
  ModelIOContract,
  ModelIOItem,
  ModelMediaKind,
  ModelInvokeRequest,
  ModelInvokeResult,
  ModelPricingInput,
  ModelProviderId,
  ModelQuoteRequest,
  ModelSelectionPreferences,
  ProviderAdapter,
  ProviderConnection,
  ProviderConnectionFailureReason,
  ProviderConnectionTest,
  ProviderConnectionTestStatus,
  PricingConfidence,
  PricingCatalog,
  PricingCatalogModel,
  PricingCurrency,
  PricingQuote,
  PricingResolver,
  PricingSourceAdapter,
  PricingStatus,
  PricingUnit
} from "./model-gateway";
export * from "@snarkroute/protocol";

export type { SnarkNodeManifest };

// Compatibility aliases for product/UI language only. Serialized route and
// package formats remain node-based (`nodes`, `nodePackage`, `.snarknode`).
export type SnarkNodePackageManifest = SnarkNodeManifest;
export type BlockManifest = SnarkNodeManifest;
export type BlockPackageManifest = SnarkNodePackageManifest;
