# SnarkRoute Capability Inventory

## 1. Executive Summary

SnarkRoute is currently a local-first visual route/workflow editor plus execution backend for Open Route Protocol style route documents. The main working capabilities are: React Flow canvas editing, typed node connections, route import/export, localStorage save/restore, bundled node execution, installed node package management, prompt/resource library support, local asset handling, and execution with logs/results/economics metadata.

Confidence: high. Based on `apps/studio`, `apps/server`, `packages/protocol`, `packages/nodes`, `packages/executor`, and focused tests.

## 2. User-Facing Studio Capabilities

| Capability | What the user can do | Status | UI | Relevant files | Notes / limitations |
|---|---|---:|---|---|---|
| Canvas editing | Add, move, select nodes/edges on React Flow canvas | implemented | Main canvas | `apps/studio/src/main.tsx` | Uses `@xyflow/react`; positions serialize to `ui.x/y`. |
| Node palette | Add nodes by click or drag | implemented | Left sidebar | `apps/studio/src/main.tsx` | Catalog comes from `/api/nodes`; fallback hardcoded library exists. |
| Node search / categories | Browse grouped node categories | partially implemented | Left sidebar | `apps/studio/src/main.tsx` | Categories implemented; no actual search box found. |
| Node connections | Connect typed output handles to typed input handles | implemented | Canvas handles | `apps/studio/src/main.tsx` | Compatibility allows exact kind, `data`, and text/json crossover. |
| Add compatible node from output drag | Drag from source output to empty canvas, choose compatible node | implemented | Floating "Add connected node" menu | `apps/studio/src/main.tsx` | Only starts from source handles. |
| Node deletion | Delete selected/context node and attached edges | implemented | Toolbar, keyboard, context menu | `apps/studio/src/main.tsx` | Delete/Backspace disabled inside text fields. |
| Context menu | Right-click node/pane/selection actions | implemented | Canvas context menu | `apps/studio/src/main.tsx` | Includes delete, collapse, back, clear, subroute actions. |
| Save / load | Save/load current project locally | implemented | Left toolbar | `apps/studio/src/main.tsx` | Uses browser `localStorage`, not server-side project files. |
| LocalStorage restore | Restores saved project on app load | implemented | Startup | `apps/studio/src/main.tsx` | Falls back to blank route if saved route cannot parse. |
| Import / export route | Import route file; export `.orp` text download; drop route onto canvas | implemented | Toolbar and drag/drop | `apps/studio/src/main.tsx`, `packages/protocol/src/index.ts` | Supports `.orp`, `.orp.json`, `.orp.yaml`, `.route.*`, plain JSON/YAML; UI also maps `.opt` to `.orp` on drop. |
| Installed node management | Install from file/path/URL/library; enable/disable/read README/uninstall | implemented | Right Settings panel | `apps/studio/src/main.tsx`, `apps/studio/src/nodePackageImport.ts`, server node APIs | Bundled nodes cannot be uninstalled. |
| Missing-node placeholders | Preserve unknown/disabled/uninstalled node instances and warn | implemented | Node card warning | `apps/studio/src/main.tsx`, `packages/nodes/src/package-system.ts` | Validation reports missing node type. |
| Compound / Subroute nodes | Collapse selected nodes into `compound.subroute` | implemented | Toolbar/context menu | `apps/studio/src/main.tsx`, `packages/executor/src/index.ts` | Port exposure chosen via browser prompts. |
| Open Subroute / Back | Enter compound internals and return to parent | implemented | Node buttons/top bar/context menu | `apps/studio/src/main.tsx` | Back saves edited subroute into parent. |
| Collapse / Uncollapse | Collapse selected graph; expand compound back into parent canvas | implemented | Toolbar/context menu/node buttons | `apps/studio/src/main.tsx` | Rewires mapped external edges. |
| Clear canvas | Remove all nodes/edges after confirmation | implemented | Toolbar/context menu | `apps/studio/src/main.tsx` | Resets outputs/run result/selection. |
| Logs / results / preview | Show logs/output JSON; inline node results; image modal/download | implemented | Bottom panel and nodes | `apps/studio/src/main.tsx` | Bottom panel starts collapsed. |
| Run / execution UI | Validate, run whole route, run node with deps, run node only | implemented | Top bar/node controls | `apps/studio/src/main.tsx`, server `/api/routes/run` | Node-only requires ready upstream outputs or immediate input nodes. |
| Dirty state / saved snapshot | Tracks snapshot and warns before opening examples | partially implemented | Open Example flow | `apps/studio/src/main.tsx` | No obvious persistent dirty indicator found. |

Confidence: medium-high. I inspected implemented handlers, but did not visually run the Studio.

## 3. Route / Graph Model Capabilities

- Route format support: implemented. JSON/YAML import/export for `.orp`, `.orp.json`, `.orp.yaml`, `.route`, `.route.json`, `.route.yaml`, plus plain JSON/YAML. Protocol code is in `packages/protocol/src/index.ts`.
- Nodes: implemented with `id`, `type`, `title`, `params`, `inputs`, `outputs`, `compound`, `capability`, `subroute`, `nodePackage`, `ui`.
- Edges: implemented with `from`, `to`, `fromPort`, `toPort`, optional `id`.
- Inputs/outputs/params: implemented as JSON-like route fields and manifest fields.
- Typed ports: implemented in Studio and manifests. Runtime reads ports by output field/path.
- Validation: implemented for schema, duplicate IDs, missing edge endpoints, `library.prompt`, `http.request`, local Stable Diffusion, economics splits. Backend adds prompt-library and node-type validation.
- Missing node handling: protocol allows unknown node types; backend validation reports missing installed node; Studio shows placeholder warning.
- Compound representation: `type: "compound.subroute"` with `compound.inputs/outputs` mappings and embedded `subroute`.
- Subroute representation: nested full `RouteDoc`.
- Exposed compound ports: implemented via mapping `{ id, kind, nodeId, port }`.
- Internal node IDs: preserved inside subroute; execution prefixes internal results as `compoundId/internalNodeId`.
- Serialization/deserialization: implemented through protocol export/load and Studio `flowToRoute`/`routeToFlow`.

Confidence: high.

## 4. Node System Capabilities

- Built-in bundled nodes: implemented. Includes text/file/image/video inputs, capability nodes, prompt library, image preview, template transform, debug log, HTTP request, local Stable Diffusion, text/file outputs.
- Provider bundled nodes: implemented server-side for Replicate model, Replicate Clarity Upscaler, Gemini LLM, Gemini Nano Banana 2.
- Installed local nodes: implemented under `data/installed-nodes`, though current `data/installed-nodes` appears empty.
- Node manifests: implemented as `snarkroute.node` JSON with permissions, executor, ports, params, metadata.
- Node library import: implemented for `snarkroute.nodeLibrary` URL preview/install.
- Node URL import: implemented for manifest JSON or `.snarknode` URL.
- Local path/file import: implemented for dev folder, manifest path, `.snarknode`, `.node.json`, JSON file.
- Permissions metadata: implemented and displayed; env is allowlisted for plugin nodes; shell permission is refused at runtime.
- Executor types: `builtin`, `plugin`, `declarative.http` run. Plain `declarative` validates but I did not find a runner registration, so likely non-executable.
- Declarative nodes: partially implemented. `declarative.http` works; generic `declarative` unclear/likely not runnable.
- Plugin nodes: implemented by importing executor module and calling `runNode(context)`.
- Example/scaffold nodes: present under `examples/custom-nodes`.

Confidence: high for package system, medium for generic `declarative`.

## 5. Execution Capabilities

- Execution order: implemented via topological sort and cycle detection.
- Template interpolation: implemented for `{{nodeId.output.path}}`; dependencies must have edges.
- Compound node execution: implemented by executing embedded subroute with synthetic input nodes.
- Internal subroute execution: implemented; internal logs/results are folded into parent run with prefixes.
- Logs: implemented per run and per node.
- Results: implemented as `nodeResults`, persisted to `run.json`.
- Errors: implemented; failures return run status `failed` with node error details.
- Provenance: implemented at run/node/provider level.
- Cost usage: metadata/accounting only; provider usage tracked, payment always false.
- Asset/output handling: output directory per run; generated/downloaded images and output files written into run folders.
- Known executor limitations: no arbitrary shell; missing runner fails; generic `declarative` likely not executable; external providers require tokens/local services; template references require explicit edges.

Confidence: high.

## 6. Backend / API Capabilities

Implemented endpoints in `apps/server/src/index.ts` include:

- Health: `GET /api/health`
- Settings: `GET /api/settings`, `POST /api/settings/replicate-token`, `POST /api/settings/gemini-token`
- Node catalog/install: `GET /api/nodes`, `GET /api/node-packages/installed`, preview/install file/path/url/library, enable/disable, delete, README
- Routes: `GET /api/routes/examples`, `GET /api/routes/examples/:filename`, `GET /api/routes/saved`, `POST /api/routes/validate`, `POST /api/routes/run`
- Runs/ledger: `GET /api/runs/:runId`, `GET /api/ledger/runs`, `GET /api/ledger/runs/:runId`, `GET /api/ledger/summary`
- Prompt library: list, prompt read, refresh
- Assets: metadata, preview, browse, import
- Provider helpers: Replicate schema, local Stable Diffusion models

Known limitations: saved routes API lists asset route files but Studio save/load uses localStorage; local file browse is Windows-only; external model calls depend on secrets and network/local backends.

Confidence: high.

## 7. File And Package Map

| Path | Responsibility | Important files | Notes |
|---|---|---|---|
| `apps/studio` | React Studio UI | `src/main.tsx`, `src/nodePackageImport.ts`, `src/security-ui.ts`, `src/styles.css` | Actual app folder is `apps/studio`, not `apps/web`. |
| `apps/server` | Fastify API server | `src/index.ts`, tests | Actual API folder is `apps/server`, not `apps/api`. |
| `packages/protocol` | Route schema/import/export/validation | `src/index.ts`, `test/protocol.test.ts` | Equivalent to route-core protocol layer. |
| `packages/executor` | Graph execution engine | `src/index.ts`, `test/executor.test.ts` | Topological execution, templates, compound, ledger. |
| `packages/nodes` | Built-ins, node package system, prompt/resources, local assets | `src/index.ts`, `src/package-system.ts`, `test/nodes.test.ts` | Central node system. |
| `packages/adapters` | Provider adapters | `gemini/src/index.ts`, `replicate/src/index.ts` | External API runners. |
| `packages/storage` | Run storage | `src/index.ts` | Minimal local run persistence. |
| `examples` | Example routes and node packages | `routes/*`, `custom-nodes/*` | Good demo material. |
| `data/installed-nodes` | Installed node packages | currently empty | Runtime install target. |
| `docs` | Protocol/project docs | `custom-nodes.md`, `node-package-format.md`, `declarative-http-executor.md` | Useful but implementation was prioritized. |
| `.codex` | Codex skill metadata | `.codex/skills/snarkroute-node-builder/SKILL.md` | Repo-local agent aid, not product runtime. |

Confidence: high.

## 8. Demo Readiness

| Area | Ready for demo? | Why | Risks |
|---|---|---|---|
| Basic canvas editing | Yes | Add/move/connect/delete implemented | Visual polish not verified live. |
| Running a simple route | Yes | Built-in execution and tests cover simple routes | External providers need tokens. |
| Importing a node | Yes | File/path/URL/library install paths exist | Plugin code trust/security caveat. |
| Installed node management | Yes | Enable/disable/README/uninstall implemented | Empty installed dir by default. |
| Compound/subroute editing | Mostly | Collapse/open/back/uncollapse implemented | Prompt-based port UI is rough. |
| Save/load/reload | Yes | localStorage save/restore implemented | Not server-backed; dirty UI partial. |
| Error handling | Mostly | Validation/run errors surface in logs/results | Some UI flows may only log errors. |
| Visual clarity | Unclear | CSS/UI exists | Not verified in browser during this inventory. |

## 9. Gaps And Next Work

Demo blockers:

- None obvious for a local basic route demo.
- Provider demos require valid Replicate/Gemini tokens or local Stable Diffusion endpoint.

Important but not blocking:

- Add real node palette search.
- Add visible dirty-state indicator.
- Clarify or remove unsupported generic `declarative` executor type.
- Improve compound port editing beyond browser prompts.
- Decide whether server saved routes should be exposed in Studio.

Polish:

- Better inline validation before run.
- More guided missing-node recovery.
- Better installed node success/failure UX.
- Expand demo examples around no-token local routes.

Architectural risks:

- Plugin nodes execute imported JS/TS modules, although shell is refused and env is allowlisted.
- Route files preserve portability, but installed executors are external to route documents.
- Nested subroutes increase complexity around IDs, port mappings, and execution diagnostics.

## 10. Suggested Demo Scripts

1. Basic route demo

Steps: Open Studio, add `Text Input`, `Template Transform` or `Debug Log`, connect text output, validate, run.

Expected visible result: logs show node starts/completions; outputs panel shows run JSON/text.

What this demonstrates: canvas editing, typed connections, validation, execution, logs/results.

2. Installed node demo

Steps: Use Settings -> Node Packages, install `examples/custom-nodes/http-json-declarative.snarknode` or a manifest/path, add node to canvas, run or validate, then disable/uninstall.

Expected visible result: node appears in palette/installed list; uninstall preserves existing route node as missing placeholder.

What this demonstrates: portable node packages, permissions metadata, installed node lifecycle, missing-node behavior.

3. Compound/subroute demo

Steps: Build a small two-node chain, select both, click Collapse, open subroute, edit/move internal nodes, Back, run parent route, then Uncollapse.

Expected visible result: compound node replaces selection; internal route opens; parent receives updated subroute; uncollapse restores nodes.

What this demonstrates: compound representation, subroute editing, exposed ports, nested execution.

## 11. Confidence Notes

- Executive summary: high.
- Studio capabilities: medium-high; source is clear, but I did not launch a browser to visually confirm.
- Route/model: high; protocol and tests are explicit.
- Node system: high, except generic `declarative` executor is medium/low because validation exists but runner registration was not found.
- Execution: high; executor tests cover order, templates, compound, errors, ledger.
- Backend/API: high; endpoints are centralized in one server file and covered by focused tests.
- Demo readiness: medium; implementation looks demoable, but visual clarity and live provider readiness need a browser/server check next.
