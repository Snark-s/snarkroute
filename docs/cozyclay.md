# CozyClay in SnarkRoute / Мастерская

Status: CozyClay Studio 3.1.2 installed and running on this Windows host.
Owner confirmed an independent diagnostic PASS:
- HTTP 200 and CozyClay identity at 127.0.0.1:5180/app/
- `cozyclay live status` exit code 0
- `cozyclay live inspect --scope scene` exit code 0.

The canonical `service-endpoints.json` was registered by the owner:
- cozyclay HTTP /app/ port 5180
- cozyclay_live TCP port 5184
- paths.cozyclay points to Y:\Приложения\CozyClay.

## Workshop tile and terminal

Implementation written in source, but pending build/test activation:
- `apps/server/src/services/cozyclay-workshop.ts`: HTTP identity probe,
  manual vs managed process awareness, local Node process launcher,
  logs and stop only for a PID this API instance launched.
- `apps/server/src/routes/system.ts`: catalog entry, list/open/status/stop,
  shared terminal log provider (manual + managed).
- `apps/launcher/src/main.tsx`: tile, terminal button, guarded Stop.
- `apps/server/test/system-apps.test.ts`: catalog expectations.
- `apps/server/src/services/local-service-endpoints.ts`: typed service IDs.

**DO NOT restart SnarkRoute until the owner-run preflight passes.**
Run `Y:\Приложения\CozyClay\CHECK_WORKSHOP.cmd`.
It runs server typecheck, launcher build and system-apps tests, writing
`WORKSHOP-CHECK.txt` and `WORKSHOP-CHECK.log`. No service restart.
If PASS, perform a controlled server reload and smoke test /health,
GET /api/system/apps, and the CozyClay tile and Терминалы / CozyClay.
Preserve all unrelated uncommitted project changes.

## MCP scene tools

The original experimental MCP glue was withdrawn after breaking SnarkRoute.
Source copies are under `Y:\Приложения\CozyClay\integration-disabled`.
They are **not active**. The working CozyClay native CLI can inspect scenes;
only restore SnarkRoute MCP tool registration as a separately tested phase.
No model/provider calls are made through the Workshop wrapper. Use SnarkRoute
Model Gateway for video generation.

## Compatibility

The npm package CozyClay 3.1.2 omitted `mcp/project-camera.mjs`.
The official source file was placed into the local MCP runtime cache
and preparation script. The original npm package remains unchanged.
Do not run a second standalone `cozyclay mcp` over the Studio live hub.
SnarkBridge owner approval currently blocks remote command execution; this
must not be bypassed by broadening access to protected code/policy paths.
