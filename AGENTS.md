# SnarkRoute Agent Instructions

SnarkRoute is the reference implementation. Open Route Protocol is the portable standard.

- Keep `.route.yaml` and `.route.json` files portable across tools.
- Preserve route compatibility unless a documented protocol migration is added.
- Treat the route/workflow as the primary unit of value.
- Models, APIs, tools, and media processors are providers inside a route.
- Preserve economics and provenance metadata even when MVP execution ignores them.
- Do not add payments, marketplace features, user accounts, or cloud assumptions yet.
- Do not execute arbitrary plugin or community JavaScript code.
- Future community nodes must be declarative manifests with explicit permissions.
- Write tests before complex behavioral changes.
- Prefer a simple working implementation over a broad platform-shaped skeleton.
