# Security Policy

## Secrets

Secrets must never be committed. This includes API keys, provider tokens, passwords, private paths, local run outputs, and user assets.

Routes and bundles must not contain secret values. Store provider credentials in local `.env` files or local settings only. `.env.example` must remain placeholder-only.

## Reporting Security Issues

Please report security issues privately to the project maintainer before public disclosure. Do not include real tokens, private user files, or exploitable payloads in public issues.

## Community Code Execution

SnarkRoute does not support arbitrary community JavaScript execution. Future community nodes must be declarative manifests with explicit permissions and auditable behavior.

## Asset Resolution

Routes do not directly fetch arbitrary files or URLs. Reusable external resources are referenced through AssetRef and resolved by the host through explicitly configured AssetSources.

Asset manifests must be schema-validated. Asset kind must match what the consuming node expects. Hash pinning should be supported for reproducibility; missing assets must produce clear diagnostics, and changed assets should warn when `expectedHash` is present.

Remote Node Definition Assets must describe interfaces, metadata, execution adapters, permissions, and credential requirements. They must not execute arbitrary downloaded JS/TS/Python code by default. Credentials remain host-side and are never embedded into routes.

## Token Handling

Provider tokens are read by the local server. Studio must not receive raw provider tokens except when the user is actively saving one through Settings. Tokens must not appear in logs, run ledgers, route exports, tests, or generated files.

## MVP Limitations

The current MVP is local-first and single-user. It does not include authentication, cloud isolation, multi-user permissions, sandboxed plugin execution, or marketplace review.

## Generated Outputs

Generated outputs are the user's responsibility, especially when external APIs or models are used. Rights and restrictions can depend on the model, provider, route, nodepack, and service terms.

This document is licensed under CC BY-SA 4.0.
