# Agent Context Index

This file is a lookup map. It is not required reading for every task.

Use it only when deciding which files are relevant.

## Route format tasks

Likely areas:

- `packages/route-core`
- `examples`
- `docs`

Look for:

- route schema
- validation
- example `.route.json`, `.route.yaml`, or related files
- protocol documentation

## Execution tasks

Likely areas:

- `packages/route-core`
- `apps/api`

Look for:

- graph execution
- dependency ordering
- interpolation
- run endpoints
- execution logs

## UI editor tasks

Likely areas:

- `apps/web`

Look for:

- React Flow components
- node palette
- node inspector
- preview/output UI
- import/export UI

## Adapter tasks

Likely areas:

- `packages/adapters`
- `apps/api`
- `examples`

Look for:

- existing adapter patterns
- API credential handling
- route examples using adapters
- focused adapter tests

## Documentation tasks

Likely areas:

- `docs`
- root README
- examples

Do not inspect application source unless the documentation task requires verification.

## Philosophy or governance tasks

Likely areas:

- `docs`
- README
- project manifesto files, if any

Do not inspect app source unless explicitly needed.

## Generated, archive, and temporary files

Avoid by default:

- `archive`
- `generated`
- `temp`
- `dist`
- `build`
- old reports
- logs
- large output folders

Read them only if the user explicitly asks.
