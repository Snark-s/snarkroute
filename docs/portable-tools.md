# Portable tools from collapsed nodes

Portable Tool Schema v1 separates a published workflow from any After Effects, Photoshop, or BoojumRoute UI. The server is authoritative: clients may render a schema, but cannot submit a modified schema or an undeclared parameter.

## Lifecycle

1. BoojumRoute collapses a typed subroute and writes a declarative `.snarknode` manifest.
2. `canvasButtonBuilder.ts` adds `tool` only when public inputs/outputs and internal mappings are resolvable.
3. `packages/nodes/src/portable-tool.ts` validates the schema when the package is installed and again when the server catalog is built.
4. `GET /api/tools` publishes only valid, enabled tools. Invalid candidates appear in `diagnostics`; they do not become broken buttons.
5. A host filters by its declared contract and renders fields from the schema.
6. `POST /api/tools/:id/jobs` resolves the schema again on the server, validates host, fields, assets and limits, and executes the referenced node action.

Legacy `canvasAction.enabled` manifests remain supported through `migrateLegacyCanvasAction`. Migration publishes BoojumRoute-compatible fields; it does not guess Adobe-specific capture or placement behavior.

## Schema

The TypeScript source of truth is `PortableToolSchema` in `packages/nodes/src/portable-tool.ts`. A minimal shape is:

```json
{
  "schemaVersion": "1.0",
  "id": "example.video",
  "title": "Example video",
  "version": "1.0.0",
  "action": { "kind": "node", "value": "example.video" },
  "inputs": [{
    "id": "firstFrame",
    "type": "image",
    "source": "upload",
    "hostSources": { "after_effects": "host_first_frame" },
    "acceptedMimes": ["image/png", "image/jpeg"]
  }],
  "params": [{ "id": "duration", "type": "duration", "default": 5, "min": 4, "max": 15 }],
  "outputs": [{
    "id": "video",
    "type": "video",
    "placement": "new_artifact",
    "hostPlacements": { "after_effects": "replace_placeholder" }
  }],
  "hosts": [{
    "host": "after_effects",
    "sources": ["manual", "upload", "host_first_frame"],
    "placements": ["replace_placeholder", "project_item"]
  }],
  "job": {
    "states": ["queued", "starting_provider", "generating", "completed", "failed", "cancelled"],
    "cancellable": true,
    "retryable": true,
    "selectableResults": true
  }
}
```

Supported field types include text, multiline text, number, integer, boolean, select, image(s), video(s), audio, mask, seed, duration, resolution, and host-derived selection/layer/frame/work-area values. Constraints include required/default, numeric ranges, select options, multiple/minItems/maxItems, MIME patterns, exact-selection flags and context padding.

The schema contains host capabilities and semantic placement, never ScriptUI/React/UXP controls. Secrets are forbidden in public field ids and metadata. Endpoint actions must be relative `/api/` paths without traversal.

## Validation and diagnostics

Publication fails on missing/duplicate ids, unsupported types/sources/placements, missing output, invalid defaults/ranges/MIME patterns, unresolved collapsed-subroute mappings, node action mismatch, secret-shaped public fields, missing host coverage, or non-serializable data. Use `validatePortableToolSchema` for new producers and surface the returned `path`, `code`, `message`, and `severity`.

## Adding a field type

1. Add the semantic type and validation rules in `portable-tool.ts`.
2. Decide whether it is parameter data, uploaded media, or a host capture.
3. Add capability mapping and pure coercion/validation in each supporting host. Unsupported hosts must reject the tool with a reason.
4. Add schema, migration, host mapping, and server request-validation tests.
5. Do not add provider-specific rules to an Adobe panel; keep them in the node/provider adapter.

## Job API

- `GET /api/tools?host=after_effects|photoshop|boojumroute`
- `GET /api/tools/:id`
- `POST /api/tools/:id/jobs`
- `GET /api/tool-jobs/:id`
- `POST /api/tool-jobs/:id/cancel`
- `POST /api/tool-jobs/:id/select-result`

Create requests include `schemaVersion`, `hostType`, declared inputs and parameters, redacted source context, correlation id and idempotency key. Imported files must remain under SnarkRoute asset storage and pass size/MIME checks. Binary values are materialized only for execution and are not written to ordinary job JSON.

## Current limits

- Multiple-result selection is supported. A single field carrying several uploaded files is represented by the schema, but the current AE form captures one file per media field; use several declared fields until the panel gains a multi-file picker.
- Endpoint-backed schemas are discoverable, but execution requires a dedicated server adapter rather than arbitrary client-selected URLs.
- Provider cancellation is best-effort. SnarkRoute prevents a cancelled job from publishing a late result; an adapter needs an upstream cancellation primitive to stop already-running compute.
