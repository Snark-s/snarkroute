# Local After Effects MCP

SnarkRoute exposes a local Streamable HTTP MCP server at `http://127.0.0.1:4317/mcp`. The existing Fastify process owns both MCP and `ws://127.0.0.1:4317/api/ae-bridge`; there is no second backend. The CEP panel keeps an authenticated WebSocket open, and commands travel through `CSInterface.evalScript()` into the open After Effects project.

```text
Codex desktop/CLI/IDE -> POST/GET/DELETE /mcp -> @snarkroute/server
  -> per-session queue -> /api/ae-bridge WebSocket -> CEP -> evalScript -> AE DOM
```

## Configure tokens

Copy `.env.example` to the root `.env` if needed and set long random values:

```dotenv
SNARKROUTE_MCP_TOKEN=replace-with-a-long-random-value
# Optional development/admin fallback only; normal local pairing does not need it.
SNARKROUTE_AE_BRIDGE_TOKEN=
```

There are no default MCP secrets. Without `SNARKROUTE_MCP_TOKEN`, `/mcp` returns a configuration error while all other SnarkRoute routes continue to work. In local mode the CEP panel automatically requests a short-lived, one-time credential from `/api/ae-bridge/pair`; it is consumed by the WebSocket handshake and is never persisted. `SNARKROUTE_AE_BRIDGE_TOKEN` remains an optional, separate development/admin fallback and must not reuse the MCP token.

## Build, install, and launch

```powershell
corepack pnpm install
corepack pnpm build:after-effects
corepack pnpm install:after-effects
.\start-snarkroute-ae.bat
```

You can drag an `.aep` file onto `start-snarkroute-ae.bat`. The launcher sets `SNARKROUTE_AUTO_OPEN=0`, reuses a backend that already answers `/api/health`, otherwise starts the normal `start-snarkroute.bat`, waits for readiness, and launches After Effects 2026, 2025, or 2024.

Open **Window > Extensions (Legacy) > SnarkRoute** and verify `MCP server: reachable`, `AE Bridge: connected`, and `AE session: registered`. Existing video-generation controls remain in the same panel.

## Connect local Codex

The token must be available in the environment of Codex, then add the Streamable HTTP server:

```powershell
$env:SNARKROUTE_MCP_TOKEN = "the-same-value-from-root-env"
codex mcp add snarkroute-ae --url http://127.0.0.1:4317/mcp --bearer-token-env-var SNARKROUTE_MCP_TOKEN
codex mcp list
```

Restart the Codex desktop app/IDE extension after changing MCP configuration. Codex cloud cannot reach a service bound to your computer's `127.0.0.1`; use local Codex desktop, CLI, or IDE.

## Tools

- `ae_list_sessions` (read-only)
- `ae_get_project` (read-only)
- `ae_get_active_comp` (read-only)
- `ae_list_layers` (read-only; shallow by default)
- `ae_run_arbitrary_jsx` (`execute` or `preview`, unrestricted local JSX)
- `ae_create_text`
- `ae_import_file`
- `ae_import_subtitles`
- `ae_set_property`
- `ae_apply_expression`
- `ae_precompose`
- `ae_add_to_render_queue`

When exactly one panel is connected, `sessionId` may be omitted. With multiple sessions it is required and the error lists the candidates. Commands are serialized separately for each session. A timeout stops the server waiting for the result, but ExtendScript cannot be reliably interrupted in the middle of execution; late results are discarded.

`ae_import_subtitles` accepts SRT text or a local SRT path. It creates one editable text layer, stores cue text and duration in layer markers, and applies a Source Text expression that displays the active cue.

## Arbitrary JSX example

Call `ae_run_arbitrary_jsx` with `mode: "execute"` and:

```javascript
(function () {
    var comp = app.project.activeItem;

    if (!(comp instanceof CompItem)) {
        throw new Error("Нет активной композиции");
    }

    var layer = comp.layers.addText("Привет из Codex MCP");

    return {
        layerName: layer.name,
        layerIndex: layer.index,
        compName: comp.name
    };
})();
```

The wrapper supplies `console.log`, `console.warn`, and `console.error`; their messages are returned in `logs`. Results may be primitives, objects, arrays, or `undefined`. JSX errors include message, stack, line, and file name when After Effects exposes them. No allowlist restricts the AE DOM or ExtendScript `File`/`Folder` APIs.

## Manual smoke test

1. Start SnarkRoute and After Effects; open the SnarkRoute panel and an active composition.
2. Call `ae_list_sessions` and note the session/project.
3. Call `ae_get_active_comp`.
4. Run the example above first with `mode: "preview"`, then `mode: "execute"`.
5. Confirm the returned layer name/index and verify the text layer in AE.
6. Undo once and confirm the configured undo group removes the change.

## Troubleshooting

- **MCP 503:** set `SNARKROUTE_MCP_TOKEN` in root `.env` and restart the backend.
- **MCP 401:** Codex's environment token differs from the root `.env` value.
- **Pairing unavailable:** confirm the backend is local (`APP_MODE=local`) and the panel uses a loopback URL such as `127.0.0.1:4317`; cloud mode deliberately disables local pairing.
- **AE Bridge disconnected:** keep the CEP panel open; it automatically repeats the health check, obtains a fresh one-time credential, and reconnects.
- **No AE sessions:** the panel is not open/authenticated, or its heartbeat expired.
- **CEP panel missing:** build/install it and enable Adobe CEP `PlayerDebugMode=1` as described in `apps/after-effects-panel/README.md`.
- **Timeout:** AE may still be executing the JSX; wait before sending a conflicting manual operation.
