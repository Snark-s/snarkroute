# Bonsai 2 family in SnarkRoute (local Ollama)

As of 17 October 2026, Ollama publishes four official Bonsai 2 variants:

| Model ID | Use as a starting point |
| --- | --- |
| `bonsai-2:2b` | Very lightweight classification / quick tasks |
| `bonsai-2:4b` | Lightweight text agent |
| `bonsai-2:9b` | General local assistant and tool-use trials |
| `bonsai-2:27b` | More capable reasoning / planner trials, GPU memory permitting |

These are *candidate roles*, not validated tool-use or intelligence benchmarks.
The 2B, 4B, 9B and 27B models are alternate runtimes and should not all be loaded on the GPU simultaneously.

## Safety and installation status (17 October 2026)

**Do not use stock Ollama for production Bonsai 2 agents yet.** Registry pull returns HTTP 412 on Ollama 0.30.11. Ollama 0.40.6 pre-release introduced Q2_0 tensor recognition, but PrismML states that its Bonsai 2 Hadamard transforms are still missing from mainline llama.cpp. Loading a Q2_0 file without these transforms can return meaningless text without an error. Use the official PrismML llama.cpp fork for real agent inference. The experimental Ollama adapter and script must not be enabled by default.

For reference only, the experimental pull script requires an explicit `-AllowExperimentalOllama` opt-in and Ollama 0.40.6+; successful pulling does not establish correct outputs.

Run the experimental Windows installer only if consciously investigating runtime compatibility:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "Y:\Процесс\SnarkRoute\scripts\install-bonsai2-ollama.ps1" -AllowExperimentalOllama
```

To install one size first or verify inference serially:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "Y:\Процесс\SnarkRoute\scripts\install-bonsai2-ollama.ps1" -Sizes 9b -SmokeTest -AllowExperimentalOllama
```

The script only pulls missing weights using the existing Ollama CLI. It does not delete, overwrite, restart, or stop unrelated workloads. `-SmokeTest` sends a tiny local text prompt to one size at a time with `keep_alive=0`. On this laptop, ensure headroom before inference with 27B.

## SnarkRoute discovery

The `local_openai` adapter now adds one optional, allowlisted provider endpoint:
`http://127.0.0.1:11434/v1` using the existing registered `ollama_inference` port.

- Existing dedicated Bonsai 27B at `127.0.0.1:8081/v1` remains the primary unchanged.
- Existing `LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON` definitions remain honored. If it already includes Ollama, the four IDs are merged into that explicit allowlist.
- If Ollama is already the primary provider, it is not added twice.
- Only IDs present in the local Ollama `GET /v1/models` are exposed as available.
- Automatic optional discovery returns no offline placeholders. Other manually configured endpoints retain their previous offline diagnostics.
- Each size has its own canonical ID: `bonsai-2-2b`, `bonsai-2-4b`, `bonsai-2-9b`, `bonsai-2-27b`.
- Requests still use the physical Ollama model ID; no silent fallback to cloud and no cloud provider charges.
- The available models can be selected in SnarkRoute `ai.text` routes. Tool-use and vision compatibility need real model-level end-to-end tests before autonomous agent promotion.

## Activate and validate

1. Download the four models using the script (requires owner's local execution permission).
2. Restart the SnarkRoute server after applying the source changes.
3. Open `http://127.0.0.1:4317/api/models/v1?provider=local_openai` and confirm the four individual `providerModelId` entries show `availability.status = available`.
4. Test `ai.text` on 2B and 9B with a short prompt. Run a native tool-call round trip before deploying any model as an autonomous agent.
5. Run `pnpm --filter @snarkroute/server exec vitest run test/bonsai2-family-ollama.test.ts` (adjust workspace package command if needed).

### Backend compatibility note

PrismML's `PQ2_0`/`PTQ1_0` GGUF packages need the PrismML-compatible kernels. The separately published official Ollama model tags are intended for Ollama; **verify actual decoding on the installed Ollama version** before trusting their outputs. A successful model pull is *not* proof that inference or tool calling works.

References:
- https://registry.ollama.com/library/bonsai-2
- https://github.com/PrismML-Eng/Bonsai-demo
