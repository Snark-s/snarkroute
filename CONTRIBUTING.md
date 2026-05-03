# Contributing To SnarkRoute

SnarkRoute is the reference implementation for Open Route Protocol. Please keep route documents portable and preserve compatibility unless a documented protocol migration is added.

## Run The Project

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm build
corepack pnpm dev
```

Run server and Studio separately when debugging:

```bash
corepack pnpm dev:server
corepack pnpm dev:studio
```

## Adding Built-In Nodes

Built-in node runners live in `packages/nodes`. Keep them deterministic, local-first, and safe. Do not execute arbitrary community JavaScript.

When a node changes route behavior, add focused tests in `packages/nodes` or `packages/executor`.

## Adding Provider Adapters

Provider adapters should live under `packages/adapters`. Tokens and secrets must stay server-side. Provider adapters must not expose secrets to Studio, route exports, logs, ledgers, or generated route files.

Live provider smoke tests should be explicit scripts and must not run in the normal test suite.

## Community Node Manifests

Future community nodes should be declarative manifests with explicit permissions. Do not add plugin execution or arbitrary package loading without a protocol-level security design.

## Tests

Run before submitting changes:

```bash
corepack pnpm test
corepack pnpm build
```

Live smoke tests are optional and require provider credentials:

```bash
corepack pnpm smoke:replicate
corepack pnpm smoke:clarity
```

## Secrets

Never commit `.env`, API keys, tokens, passwords, local run outputs, private assets, or user files. Keep `.env.example` safe and placeholder-only.

## Contribution Licensing

Contributed source code is accepted under AGPL-3.0-or-later.

Documentation, specification, and example route contributions are accepted under CC BY-SA 4.0 unless otherwise stated.
