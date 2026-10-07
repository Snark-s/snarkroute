# Local OpenAI-compatible text models (Bonsai 2)

SnarkRoute exposes local OpenAI-compatible servers as the generic provider `local_openai`. Bonsai 2 27B is catalogued as canonical model `bonsai-2-27b`; the physical `providerModelId` always comes from `GET /v1/models` while the runtime is reachable.

SnarkRoute does not download model weights. On Windows, install the official PrismML demo explicitly:

```powershell
git clone https://github.com/PrismML-Eng/Bonsai-demo.git
cd Bonsai-demo
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
$env:BONSAI_OPENWEBUI = "0"
$env:BONSAI_CODE_INTERPRETER = "0"
.\setup.ps1
.\scripts\start_llama_server.ps1
```

The official launcher uses the PrismML `llama.cpp` fork required by Bonsai 2, selects the `PQ2_0` download by default, listens on `127.0.0.1:8080`, and enables `--jinja` so `/v1/chat/completions` uses native OpenAI `tools` and `tool_calls`.

For an already installed demo, SnarkRoute also provides a non-downloading wrapper:

```powershell
.\scripts\start-bonsai.ps1 -BonsaiDemoPath C:\path\to\Bonsai-demo
```

Configure SnarkRoute:

```dotenv
LOCAL_LLM_BASE_URL=http://127.0.0.1:8080/v1
LOCAL_LLM_API_KEY=
LOCAL_LLM_MODEL_ID=Ternary-Bonsai-2-27B-PQ2_0.gguf
BONSAI_DEMO_PATH=I:\AI\Bonsai-demo
```

The local Workshop and Jabberwock pages use the same server-owned lifecycle endpoints to start and stop this installation. Stop targets only `llama-server.exe` from `BONSAI_DEMO_PATH` with the configured local port, so an unrelated process is never terminated just because it uses port 8080.

`LOCAL_LLM_MODEL_ID` is only the unavailable fallback identity. When discovery succeeds, the exact id returned by `/v1/models` is used. API keys are optional only for localhost; a non-local base URL requires `LOCAL_LLM_API_KEY`.

To keep a verifier on the primary Bonsai endpoint while explicitly selecting an executor from another local server, configure an additional loopback endpoint with an allowlist of already installed physical model IDs:

```dotenv
LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON='[{"baseUrl":"http://127.0.0.1:11434/v1","modelIds":["qwen3:8b","llama3:latest"]}]'
```

Discovery uses the existing catalog normalization/aliases. Only listed models from the additional endpoint are exposed; cloud IDs, duplicate IDs and non-loopback URLs are rejected. The adapter selects the endpoint by physical model ID, never retries on another endpoint, and never forwards the primary API key to an additional endpoint. Optional `reasoningEffort` (`none`, `low`, `medium`, `high`) applies only to that endpoint's requests. Absent configuration preserves existing behavior. The current AtomicAgentRuntime uses JSON `tool_actions` in text; native tools metadata alone does not establish agent compatibility. Verify real tools and final structured output before selecting an executor.
