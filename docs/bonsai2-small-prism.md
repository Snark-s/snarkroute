## Bonsai 2 small family (2B/4B/9B), 17 October 2026

The official PrismML demo now supports `BONSAI_FAMILY=bonsai2` with `BONSAI_MODEL=2B|4B|9B|27B`.
New models are available as official PQ2_0 GGUFs at:
- https://huggingface.co/prism-ml/Ternary-Bonsai-2-2B-gguf
- https://huggingface.co/prism-ml/Ternary-Bonsai-2-4B-gguf
- https://huggingface.co/prism-ml/Ternary-Bonsai-2-9B-gguf

Use the new safe installer at `scripts/install-bonsai2-prism.ps1` rather than stock Ollama.
It fast-forwards the official `I:\AI\Bonsai-demo` repo only when tracked files are clean, and invokes the upstream setup once each for 2B, 4B, and 9B, with the optional WebUI/code interpreter disabled. If the checkout contains custom changes, it aborts rather than overwriting. It verifies each PQ2_0 GGUF file by presence and size and never starts multiple models in VRAM.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "Y:\Процесс\SnarkRoute\scripts\install-bonsai2-prism.ps1"
```

SnarkRoute's dedicated Bonsai lifecycle defaults to its previous 27B configuration. You may configure the SnarkRoute **server process** environment with `BONSAI_MODEL=2B`, `4B`, `9B` or `27B` to choose a size for the dedicated server, then restart SnarkRoute and start its Bonsai runtime. Existing `LOCAL_LLM_BASE_URL` stays on the registered dedicated PrismML inference endpoint `http://127.0.0.1:8081/v1`. Only one size can be resident on that endpoint at once. Discovery maps actual served GGUF IDs to canonical Bonsai 2 2B/4B/9B/27B entries.

Before delegating autonomous tasks, verify a real text answer, native tool-call round-trip, and resource admission. Official PrismML small-model guide explicitly notes that Windows inference is not yet validated for this release: https://github.com/PrismML-Eng/Bonsai-demo/blob/main/SMALL-MODELS.md

