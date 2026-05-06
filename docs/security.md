# Security And Trust Model

SnarkRoute is local-first, but route portability still needs explicit trust boundaries.

## Rules

- Routes do not directly fetch arbitrary files or URLs.
- External AssetSources must be explicitly configured.
- Asset manifests must be schema-validated.
- Asset kind must match what the node expects.
- Hash pinning should be supported for reproducibility.
- Version metadata should be supported.
- Missing assets must produce clear diagnostics.
- Changed assets should produce warnings when `expectedHash` is present.
- Remote node definitions must not execute arbitrary downloaded code by default.
- Permissions must be visible for remote node definitions and API nodes.
- Credentials remain host-side and are never embedded into routes.

## Remote Assets

Remote assets are allowed through configured AssetSources only. A route may reference `asset://snarkdream-library/text/prompt/organic-art-nouveau`; the `snarkdream-library` source may internally point to a remote manifest. The route itself should not contain a direct prompt URL for execution.

The host should validate remote manifests, show available assets, check kind/version/hash/permissions, cache assets if needed, warn about changed or missing assets, and block unsafe or unsupported assets.

## Remote Node Definitions

Remote Node Definition Assets may describe interfaces, UI metadata, execution adapters, required permissions, and required credentials. They must not inject arbitrary executable code into SnarkRoute. The host must show permissions before enabling them.

---

This document is licensed under CC BY-SA 4.0.
