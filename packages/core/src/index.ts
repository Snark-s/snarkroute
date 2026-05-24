import type { SnarkNodeManifest } from "@snarkroute/nodes";

export * from "./living-canvas";
export {
  GatewayModelResolver,
  ModelGateway,
  ModelRegistry,
  estimateCatalogPricingQuote,
  estimatePricingCatalogQuote,
  isPricingCatalogFresh,
  providerModelRef,
  sanitizePricingQuote,
  unknownPricingQuote
} from "./model-gateway";
export type {
  ModelGatewayQuoteResult,
  ModelCapability,
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
