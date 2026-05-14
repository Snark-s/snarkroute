# Repository Instructions

## Default mode: context-budget

Context-budget mode is mandatory for this repository unless the user explicitly requests broad analysis, architecture review, repository-wide audit, or large refactoring.

For every normal task:

- Do not scan the whole repository by default.
- First identify the smallest relevant area.
- Inspect only the minimum necessary files.
- Avoid unrelated docs, archives, generated files, old reports, and large context dumps.
- Do not refactor unrelated code.
- Make the smallest safe change.
- Prefer focused checks over full-project checks.
- Explain why any extra files were inspected.

Use the reusable workflow in:

~~~text
docs/skills/context-budget.md
~~~

## Project map

Use this map to choose the smallest relevant area before reading files.

- `apps/server`: local API server, execution endpoints, settings, provider routes, local asset previews.
- `apps/studio`: BoojumRoute Lab, React Flow node editor, node panels, previews, route editing.
- `apps/snarkroute`: SnarkRoute Living Canvas experimental shell.
- `packages/core`: shared app/domain primitives used by the Living Canvas.
- `packages/executor`: route execution engine and runtime orchestration.
- `packages/nodes`: built-in node manifests, node execution helpers, `.snarknode` package system.
- `packages/protocol`: Open Route Protocol schema, validation, parsing, route compatibility surface.
- `packages/storage`: local storage helpers and run/asset persistence primitives.
- `packages/adapters`: provider-specific external model/API adapters.
- `examples`: example route documents and smoke-test routes.
- `docs`: protocol notes, architecture notes, project documentation.

Adjust this map if the actual repository structure differs.

## Never by default

- Never inspect the whole repository by default.
- Never read archive folders by default.
- Never read generated outputs by default.
- Never read old reports by default.
- Never run full-project checks if focused checks are enough.
- Never change public route format without updating examples and focused validation/tests.
- Never add dependencies unless clearly justified.
- Never modify unrelated files.

## When broad context is allowed

Broad context is allowed only when the user explicitly asks for:

- repository-wide architecture review
- full audit
- global refactor
- security review
- consistency review across the whole codebase
- project-wide documentation or migration

Otherwise, stay local and use context-budget mode.

## SnarkRoute Agent Instructions

SnarkRoute is the reference implementation. Open Route Protocol is the portable standard.

- Keep `.orp`, `.orp.yaml`, `.orp.json`, `.route.yaml`, and `.route.json` files portable across tools.
- Preserve route compatibility unless a documented protocol migration is added.
- Treat the route/workflow as the primary unit of value.
- Models, APIs, tools, and media processors are providers inside a route.
- Preserve economics and provenance metadata even when MVP execution ignores them.
- Do not add payments, marketplace features, user accounts, or cloud assumptions yet.
- Do not execute arbitrary plugin or community JavaScript code.
- Future community nodes must be declarative manifests with explicit permissions.
- Write tests before complex behavioral changes.
- Prefer a simple working implementation over a broad platform-shaped skeleton.
- Do not mix UI, API, provider, execution, and filesystem logic without a clear boundary reason.
- Keep provider-specific behavior in the adapter/provider layer.
- Do not change protocol compatibility, storage keys, route formats, or `.snarknode` behavior without an explicit migration decision.
- After changes, run focused builds/tests for the touched workspace packages; use broader checks only when the change warrants it.
