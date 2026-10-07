# Decision Layer

SnarkRoute treats specialized decision models as replaceable engines, not as part of product business logic. Jev, Needle, a local model, a general LLM, and deterministic rules can all implement the same provider-independent protocol. The system remains usable when any one provider is absent.

## Architecture

There is one registry. Decision engines are registered in the existing `ModelRegistry` beside text, image, video, transform, and utility engines. Existing `ModelInfo` descriptors now support optional engine fields:

- `kind` — `decision` for decision engines;
- `protocols` — includes `decision.v1`;
- `capabilities` — such as `decision.rank` and `decision.select_one`;
- `availability`, `priority`, `adapterId`, `limits`, pricing hints, and metadata.

The names `ModelInfo` and `ModelRegistry` remain for backward compatibility. `listEngines()` and protocol discovery expose their broader role without changing existing model selection or serialized route formats.

The portable request/response schemas live in `@snarkroute/protocol`. Runtime dispatch, adapters, fallback, and observability live in `@snarkroute/core`.

```text
caller -> decision.v1 -> DecisionDispatcher -> policy-ordered engine
                                      |-> specialized adapter
                                      |-> Model Gateway adapter
                                      `-> deterministic rules adapter
```

## Real optional providers

Both provider integrations are disabled by default. They implement `DecisionAdapter`; neither semantic requirements, capability matching, nor routing policy imports provider code.

### Jev / TypeSafe AI

`@snarkroute/jev` calls TypeSafe AI's documented `POST https://api.typesafe.ai/v1/systemone` API with Bearer authentication. It maps only official System One question types:

| `decision.v1` operation | Jev primitive | Normalized result |
| --- | --- | --- |
| `select_one`, `classify` | Choice | candidate ID, candidate probability, provider confidence |
| `score` with `metadata.scoreCriteria` | Score | numeric score and provider confidence |
| `score` with `metadata.jevQuestionType: "noul"` | Noul | probability as score; confidence derived as certainty around 0.5 |

Jev is not advertised for `rank` or arbitrary schema extraction. The default alias is `jev-latest`; diagnostics retain the concrete model reported by TypeSafe AI. Health is deliberately `configured` when a key exists because the official API has no documented zero-cost health endpoint. Authentication rejection, HTTP failure, malformed output, network failure, timeout, and low confidence become normalized states without returning provider bodies or credentials.

Configuration: `JEV_ENABLED`, `JEV_API_KEY`, `JEV_MODEL`, optional `JEV_ENDPOINT`, and `JEV_PRIORITY`.

### Needle / Cactus Compute

`@snarkroute/needle` uses the HTTP contract shipped in Needle's official playground server: `GET /model`, `POST /complete` with `{ query, tools }`, and `POST /reset`. Start the sidecar with Needle's documented `needle playground --weights ...` command and point `NEEDLE_BASE_URL` at it. SnarkRoute does not install Python, download weights, invent a native-runner wire protocol, or start an unmanaged process.

| `decision.v1` operation | Needle primitive | Normalized result |
| --- | --- | --- |
| `select_one`, `classify` | one grammar-constrained tool with an enum candidate ID | selected candidate or abstain |
| `extract` with `metadata.schema` | one grammar-constrained extraction tool | structured value |
| `tool_call` with provider-independent JSON Schema tools | Needle tool call | normalized tool name and arguments; no tool execution |

An empty `function_calls` array is an abstention. A withheld call in `suppressed_calls` is `low_confidence`. Needle is not advertised for ranking or numeric scoring, and the adapter never executes a selected tool. Confidence is marked `unavailable` when local/custom weights do not return it.

The sidecar owns the native process and model lifetime. It initializes the engine once and reuses it; SnarkRoute probes `/model`, reuses the endpoint, bounds every call, resets the session during server shutdown, and treats a missing runtime, missing weights, failed startup, crash, or invalid response as provider unavailability/error. Configuration: `NEEDLE_ENABLED`, `NEEDLE_BASE_URL`, optional non-path `NEEDLE_WEIGHTS_ID`, `NEEDLE_PRIORITY`, and `NEEDLE_HEALTH_TIMEOUT_MS`.

## Runtime and local API

The server registry includes `semantic-rules` (always available), `jev-main`, and `needle-local`. The optional engines become available only when their enable flag and required key/URL are present. The existing `semantic-rules` ID is retained for trace compatibility.

`DECISION_PRODUCTION_BACKENDS` is the explicit comma-separated fallback order. Without it, rules remain first and configured optional providers follow; engines that do not declare the requested capability are skipped. `DECISION_MAX_ATTEMPTS` and `DECISION_TIMEOUT_MS` bound fallback.

The local server exposes:

- `POST /api/decisions` — validates and executes a provider-independent `decision.v1` request;
- `GET /api/decision-engines` — declared capabilities plus safe availability/health state;
- `GET /api/decision-benchmarks` — privacy-safe completed shadow records and aggregates.

No provider field is added to the portable request. Existing route documents and `.snarknode` formats are unchanged.

## Shadow benchmark

`DecisionShadowBenchmark` wraps any `DecisionExecutor`. It awaits production, returns that exact response, then schedules sampled shadow calls in the background. Each shadow backend receives the same provider-independent request with a single-backend, single-attempt, bounded policy. Exceptions, health failures, timeouts, invalid outputs, and storage callbacks are contained and cannot alter or delay the completed production result. `close()` drains bounded pending work.

```dotenv
DECISION_SHADOW_ENABLED=true
DECISION_SHADOW_BACKENDS=jev-main,needle-local
DECISION_SHADOW_SAMPLE_RATE=0.1
DECISION_SHADOW_TIMEOUT_MS=5000
```

Sampling is independent of production selection. A shadow backend that does not officially support the operation produces `unsupported` and is never coerced into a provider-specific approximation. Semantic requirement enrichment currently uses `rank`; Jev and Needle therefore are not falsely claimed to support it. They can be compared on supported `select_one`, `classify`, `score`, `extract`, or `tool_call` requests through the same runtime.

Records contain a privacy-safe fingerprint of operation/candidate IDs/input shape, operation, production/shadow backend/provider/model, normalized result summaries, latency, agreement, and separate confidence `value`/`source`/`kind`. Prompt/input contents and credentials are never stored. Extracted values are represented only by fingerprints. An optional evaluator hook can add ground truth and evaluation outcomes later. The default sample rate is `0`, including when shadow mode is enabled without an explicit rate.

Agreement is operation-aware: exact top choice for selection/classification, normalized numeric distance for score, top-one plus top-K overlap for rank, and structural fingerprints for extraction. Aggregates are split by backend/provider/model/operation and include request/success/unsupported/error/timeout counts, success/agreement rates, average/p50/p95 latency, abstentions, and low-confidence counts.

## `decision.v1`

The first version defines five operations: `select_one`, `rank`, `classify`, `score`, and `extract`. Operation names are strings so later compatible operations can be added without changing the envelope.

Requests contain structured `input`, candidates with stable unique IDs, optional constraints (`topK`, `allowAbstain`, `confidenceThreshold`, `timeoutMs`), and metadata. They never contain provider-specific Jev or Needle fields.

Responses use the normalized states `ok`, `abstain`, `low_confidence`, `unsupported`, `timeout`, and `error`. Provider data may be retained under diagnostics for debugging, but callers route on normalized status. Adapter exceptions become a generic `error`, so provider-specific errors do not leak into business logic.

## Discovery and dispatch

`DecisionDispatcher` discovers engines by all three of these declarations:

1. `kind: "decision"`;
2. `protocols: ["decision.v1"]`;
3. an operation capability such as `decision.rank`.

It ignores engines declared unavailable. An adapter may also bridge its existing provider health check through `health()`. Backends are ordered by configured `engineIds`, or by descriptor priority when no explicit chain is supplied.

Fallback is bounded by `maxAttempts`, de-duplicates engine IDs to prevent loops, and can be configured for any normalized status. Defaults permit fallback on `error`, `timeout`, `unsupported`, and `low_confidence`. Confidence thresholds may be set in dispatcher policy or per request.

Every attempted execution can emit an observation containing only operation, backend/provider IDs, latency, normalized status, confidence, fallback count/path, reason, and optional cost. Inputs, credentials, and secrets are not included.

## Decision is not policy

A decision backend should return semantic facts or rankings: task type, complexity, relevant skill, required media, or accept/retry/escalate. It should not normally select an infrastructure provider. Model/provider selection remains a router or policy concern with access to price, latency, availability, limits, user overrides, and health.

This keeps future skill selection, tool selection, Context-IR classification, model auto-select, and post-checks on one decision protocol without letting a decision vendor own routing policy.

## Semantic engine selection

The first production-oriented consumer of `decision.v1` is semantic capability selection:

```text
normalized input / ModelIOContract facts
  -> deterministic requirements
  -> optional decision.v1 semantic enrichment
  -> EngineRequirements
  -> CapabilityMatcher
  -> GatewayModelResolver policy
  -> concrete engine
```

Two boundaries are deliberate:

- **Decision != Policy.** Decision enrichment identifies semantic needs such as preserving motion or requiring coding ability. It never returns a commercial provider or model name.
- **Requirements != Provider.** `EngineRequirements` contains only domain, operation, known inputs, required/preferred atomic capabilities, preferences, and constraints. Registry discovery and Gateway policy choose the actual engine using availability, enabled connections, pricing preferences, priority, and manual overrides.

`EngineRequirements` and its schema live in `@snarkroute/protocol`. The centralized capability taxonomy retains existing dotted capabilities such as `image.edit`, `video.generate`, and `video.upscale`, and adds provider-independent atomic features such as `video.first_last_frame`, `video.preserve_motion`, and `text.coding`. Provider modes remain inside adapters.

### Requirement priority

`EngineRequirementBuilder` merges information in this order:

```text
explicit user settings
  > deterministic input facts
  > semantic decision inference
  > defaults
```

Input counts and roles are never sent to a model to rediscover. For example, an existing video deterministically implies a video input; two images marked `firstFrame` and `lastFrame` deterministically require `video.first_last_frame`. Decision enrichment is invoked only for ambiguous prompt semantics such as “preserve the original camera movement”. Manual model selection skips semantic selection but still runs capability and availability validation.

Semantic confidence is backend-relative diagnostic data. A configurable high threshold may promote a semantic capability to a hard requirement; a lower threshold only creates a preference. Weak inference therefore cannot accidentally eliminate every engine.

### Matching and policy

`CapabilityMatcher` returns eligible engines and structured rejection reasons. Required capabilities, media input support, availability, reference limits, duration, resolution, and scale are hard filters. Preferred capabilities only contribute a score and never remove a candidate.

`SemanticEngineSelector` passes eligible engines to `GatewayModelResolver.selectCandidate()`, which is the existing Model Gateway policy boundary. Manual `model://provider/model` overrides are validated first and are never silently replaced. An unsupported result includes the missing capabilities and constraint reasons for every rejected engine.

The structured trace contains hard/soft capabilities, eligible IDs, rejected engines with reasons, the selected engine, policy reasons, and Decision Dispatcher diagnostics. Telemetry omits prompts and arbitrary input metadata.

Provider-independent examples are available through `semanticSelectionExamples()`:

- video plus two reference images -> `video.edit`, `video.reference`, `video.multi_reference`;
- first and last frame images -> `video.image_to_video`, `video.first_last_frame`;
- image plus explicit 4x upscale -> `image.upscale` with `scale: 4`.

Registering a future engine with matching atomic capabilities makes it eligible automatically. Replacing the rules or Model Gateway decision adapter with a future Jev/Needle adapter changes semantic inference only; matcher and Gateway policy remain unchanged.

### Existing model-catalog integration

The server applies this flow inside the existing `GET /api/models/for-node/:nodeType` endpoint. It does not maintain a second model list: `modelOptionsForNodeV1()` first performs the established executor-compatibility filtering, then semantic requirements filter and rank those same options. The selected canonical model and physical provider route are promoted to the front, preserving the current first-option Auto-select behavior and all existing clients.

Optional query inputs are `prompt`, `operation`, `image`, `video`, `audio`, `imageRoles`, `manualModelRef` (or legacy `model`), `quality`, `latency`, `cost`, `durationSeconds`, `resolution`, `referenceCount`, and `scale`. Existing requests without these fields remain valid. The response adds `semanticSelection` with `status`, `selection`, normalized `requirements`, and the structured `trace`; prompt text is not copied into telemetry. It also exposes `selectedModelId`, `selectedRouteId`, `selectedStoredModelId`, `selectedProvider`, and `selectedProviderModelId` inside `semanticSelection`. New callers must use these explicit identifiers instead of inferring the winner from `models[0]`; front-promotion remains only for compatibility with older clients.

Canonical catalog entries may expose several `providerRoutes`. Selection projects those routes as independent policy candidates so availability, configured status, priority, limits, and model hints can choose a concrete route. The winning route is moved to the first route position without changing the portable catalog identity or route document format.

## Rules and general-LLM fallback

`RulesDecisionAdapter` provides deterministic `select_one`, `rank`, `classify`, and `score` decisions from candidate keyword metadata or configured rules. It proves that a decision engine does not have to be a neural model and is suitable as a final fallback.

`ModelGatewayDecisionAdapter` asks the existing `ModelGateway` for structured JSON. It does not call GPT, Gemini, DeepSeek, or any other provider directly. The decision engine descriptor may set `metadata.modelRef`; otherwise the gateway applies its normal selection policy.

The executable smoke example is `runDecisionLayerExample()` in `packages/core/src/decision-layer/example.ts`. It classifies “Fix a TypeScript API handler” as `code` using only the rules backend.

## Adding `FooDecision`

Implement an adapter and register a descriptor; the dispatcher does not change:

```ts
import {
  DECISION_PROTOCOL,
  DecisionDispatcher,
  ModelRegistry,
  decisionCapability,
  type DecisionAdapter
} from "@snarkroute/core";

const fooAdapter: DecisionAdapter = {
  id: "foo",
  supports: (_engine, request) => request.operation === "rank",
  health: async () => ({ available: true }),
  execute: async (request, context) => {
    // Convert decision.v1 to Foo's API and normalize Foo's response here.
    // Use context.signal for cancellation.
    return { status: "ok", results: [{ id: request.candidates![0].id, score: 1 }] };
  }
};

const registry = new ModelRegistry([{
  id: "foo-primary",
  providerId: "foo",
  adapterId: "foo",
  title: "FooDecision",
  kind: "decision",
  protocols: [DECISION_PROTOCOL],
  capabilities: [decisionCapability("rank")],
  availability: "available",
  priority: 50,
  metadata: { credentialRef: "provider.foo.default" }
}]);

const dispatcher = new DecisionDispatcher(registry, [fooAdapter], {
  fallback: { engineIds: ["foo-primary", "rules-default"], maxAttempts: 2 }
});
```

Credentials belong in provider configuration or secret references, never in the request or registry descriptor. Adding `FooDecision` therefore requires an adapter, registration, declared protocol/capabilities, and provider configuration—but no `if (provider === "foo")` in SnarkRoute core, Context-IR, skill/tool selection, or auto-select logic.
