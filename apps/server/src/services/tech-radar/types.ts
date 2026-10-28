export type EvidenceLevel = "declared" | "documented" | "local_test";
export type Recommendation = "skip" | "watch" | "test" | "implement";
export type Decision = "skip" | "watch" | "test" | "review_integration";
export type Source = { id: string; url: string; title: string; kind: "metadata" | "readme" | "document" | "manifest" | "issues" | "releases" | "tree"; text: string };
export type Citation = { sourceId: string; quote: string };
export type Finding = { text: string; kind: "fact" | "claim" | "inference" | "unknown"; citations: Citation[] };
export type Capability = { id: string; name: string; finding: Finding; evidence: EvidenceLevel };
export type InventoryTool = { id: string; name: string; capabilityIds: string[]; evidence: EvidenceLevel; source: string; availability: "unverified" };
export type Snapshot = {
  canonicalUrl: string; name: string; description: string; branch: string; version: string | null;
  updatedAt: string | null; archived: boolean; license: string | null; sources: Source[]; warnings: string[]; fetchedAt: string;
};
export type Analysis = {
  description: Finding; capabilities: Capability[]; requirements: Finding[]; integration: Finding[];
  licensing: Finding[]; risks: Finding[]; maturity: Finding[]; practicalValue: Finding; superiority: Finding;
  suggestedStatus: Recommendation; rationale: Finding;
  testPlan: { goal: string; steps: string[]; success: string[]; resources: string[]; risks: string[]; cleanup: string[] };
};
export type AnalysisResult = { analysis: Analysis; model: { provider: string; model: string; providerCost: number; baseCost: number }; warnings?: string[] };
export type Comparison = { capabilityId: string; name: string; newToCatalog: boolean; overlaps: Array<{ id: string; name: string; evidence: EvidenceLevel; source: string; local: boolean }> };
export type Research = {
  id: string; completedAt: string; snapshot: Snapshot; analysis: Analysis; comparison: Comparison[];
  recommendation: { status: Recommendation; reason: string }; changes: string[];
  model: { provider: string; model: string; providerCost: number; baseCost: number };
};
export type Job = { id: string; projectId: string; status: "queued" | "fetching" | "analysing" | "completed" | "failed"; createdAt: string; updatedAt: string; error?: string; snapshot?: Snapshot };
export type Project = {
  id: string; sourceType: "github"; sourceKey: string; canonicalUrl: string; name: string; createdAt: string;
  research: Research[]; decisions: Array<{ status: Decision; note: string; at: string }>;
  watch: { enabled: boolean; intervalDays: number; lastQueuedAt?: string };
  notification?: { at: string; changes: string[]; seen: boolean };
};
export type Catalog = { schemaVersion: 1; projects: Project[]; jobs: Job[]; inventory: InventoryTool[] };
export type CapabilityEntry = { id: string; name: string; providers: Array<{ id: string; name: string; local: boolean; evidence: EvidenceLevel; source: string }> };
