# SnarkRoute Commons Principle

SnarkRoute is a reference implementation for Open Route Protocol. Open Route Protocol is a portable route language, not a platform.

The central promise is simple: users must be able to take a route with them. A route should remain readable, inspectable, remixable, and exportable as `.orp`, with `.orp.json`, `.orp.yaml`, and `.route.*` aliases available for compatibility and developer clarity.

## Core Idea

A route is a portable document. It can describe inputs, block nodes, edges, parameters, AssetRefs, provenance, and economics metadata without depending on one application, registry, marketplace, executor, or host.

Reusable external resources are assets. A route stores references to assets, not raw external files or arbitrary URLs. The host decides how AssetRefs are resolved, validated, cached, embedded, bundled, or blocked.

Node is an umbrella product term for a generic graph item. This commons principle is about executable protocol block nodes, not SnarkRoute ArtifactNodes.

Block nodes are free protocol components, not rent-bearing assets. A block node is a portable operation definition. It says what kind of operation exists, what it accepts, what it returns, and what permissions or dependencies it may need.

A block node is not the implementation. An implementation or provider is how that operation is executed: a local runner, hosted API, model provider, GPU server, media tool, or custom integration.

A block node also does not decide whether an asset is linked or embedded. Linked, embedded, and bundle are export modes.

## What Block Nodes Must Not Contain

A block node definition must not include pricing, royalties, DRM, license checks, mandatory payment services, exclusive ownership claims, or arbitrary executable code downloaded from a remote source.

Those things may exist around execution or business relationships, but they are not part of the canonical protocol block node.

## Where Paid Value Can Exist

Paid value may exist around:

- execution
- APIs
- GPU servers
- storage
- support
- hosted services
- custom integrations
- route authorship
- final products

This keeps the protocol commons open while leaving room for people to build useful businesses around real services, labor, infrastructure, and creative work.

## Separations

- Block node is not implementation.
- Route is not database.
- Executor is not protocol.
- Registry is not truth.
- Marketplace is not economy.
- Validator is not judge.
- UI is not source of reality.

These separations keep each layer replaceable.

## Portability

Dependencies should be visible. If a route depends on a proprietary model, hosted API, paid service, local path, AssetSource, custom runner, or non-portable provider, that dependency should be inspectable.

Proprietary or paid implementations may exist, but they must be clearly marked as implementations/providers, not canonical nodes.

Validators should classify portability risks. They should help users understand whether a route depends on a specific provider, host, path, credential, or runtime. Validators should not block routes for policy reasons.

## Replaceable Layers

Every key layer should remain replaceable:

- specification
- nodes
- routes
- registry
- executor
- UI
- templates
- documentation

A registry can help discovery, but it is optional. A marketplace can help exchange, but it is not the economy. A UI can help editing, but the route document remains the source of reality.

## MVP Boundary

This principle is documentation-first. It does not require a marketplace, payment system, royalty system, DRM, license enforcement, central hub, governance system, certification layer, verified-author logic, or blocking policy enforcement.

The goal is to protect the direction of SnarkRoute without making the MVP heavier.

---

This document is licensed under CC BY-SA 4.0.
