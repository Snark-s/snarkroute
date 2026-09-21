import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import Settings
from ..models import CapabilityView, GenerateRequest, ResultMetadata
from .base import BackendFailure, BackendOutput, CapabilityUnavailable, ProgressCallback

MODEL_REVISION = "8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3"
TEN_EROS_REVISION = "8a198588c8870ab0d613b3492a3150d091c8c2dd"
COMFYUI_REVISION = "f938505952476e48a12687eac696cdc94d48a3fe"
COMFY_KITCHEN_VERSION = "0.2.31"


class MatlowInt8Backend:
    """Embedded, headless Comfy core runtime for the fused MATLOWAI checkpoint.

    This adapter never starts a ComfyUI web server and never exposes workflow JSON.
    Comfy's loader, model-management and sampler modules are used as a Python library.
    """

    name = "matlow_int8"
    version = f"model:{MODEL_REVISION};comfy:{COMFYUI_REVISION};kitchen:{COMFY_KITCHEN_VERSION}"

    def __init__(
        self,
        settings: Settings,
        runtime_factory: Callable[[Settings], Any] | None = None,
    ):
        self.settings = settings
        self._runtime_factory = runtime_factory
        self._runtime_instance: Any | None = None

    def _configuration_error(self) -> str | None:
        required = {
            "ComfyUI core": self.settings.matlow_comfyui_dir,
            "transformer": self.settings.matlow_transformer_file,
            "text encoder": self.settings.matlow_text_encoder_file,
            "video VAE": self.settings.matlow_video_vae_file,
            "audio VAE": self.settings.matlow_audio_vae_file,
        }
        for label, path in required.items():
            if not path.exists():
                return f"MATLOWAI {label} is missing: {path}"
        return None

    def _model_path(self, variant: str) -> Path:
        return {
            "h3_base": self.settings.matlow_transformer_file,
            "10eros_max": self.settings.matlow_10eros_max_file,
            "10eros_max_turbo": self.settings.matlow_10eros_max_turbo_file,
        }[variant]

    def models(self) -> list[dict[str, Any]]:
        shared_ready = self._configuration_error() is None
        definitions = [
            ("h3_base", "MiniMax H3 (legacy local fast)", "preview", 4, MODEL_REVISION),
            ("10eros_max", "H3 · 10Eros Max", "final", 8, TEN_EROS_REVISION),
            ("10eros_max_turbo", "H3 · 10Eros Max Turbo", "preview", 6, TEN_EROS_REVISION),
        ]
        return [
            {
                "id": model_id,
                "family": "h3",
                "variant": model_id,
                "display_name": display_name,
                "purpose": purpose,
                "default_steps": steps,
                "minimum_steps": 4,
                "maximum_steps": 4 if model_id == "h3_base" else 8,
                "revision": revision,
                "weights_installed": shared_ready and self._model_path(model_id).is_file(),
                "recommended_for_16gb": model_id == "10eros_max_turbo",
                "reference_modes": ["t2va", "fl2va", "ref2va"],
                "style_transfer_verified": False,
            }
            for model_id, display_name, purpose, steps, revision in definitions
        ]

    def _runtime(self):
        if self._runtime_instance is None:
            if self._runtime_factory is not None:
                self._runtime_instance = self._runtime_factory(self.settings)
            else:
                from .matlow_runtime import MatlowRuntime

                self._runtime_instance = MatlowRuntime(self.settings)
        return self._runtime_instance

    def capabilities(self) -> list[CapabilityView]:
        configured = self._configuration_error() is None
        missing_reason = self._configuration_error()
        return [
            CapabilityView(
                name="fl2va",
                available=configured,
                experimental=True,
                reason=missing_reason
                or "T2VA, 10-second FL2VA and first/last frames passed local GPU generation",
            ),
            CapabilityView(
                name="ref2va",
                available=configured,
                experimental=True,
                reason=missing_reason or "Experimental visual Ref2VA with native generated audio: image and video references up to 15 seconds at 24 fps; audio references remain unavailable",
            ),
            CapabilityView(
                name="preview",
                available=configured,
                experimental=True,
                reason="local_fast: fused Turbo INT8, res_multistep/simple, 4 steps, 960x544",
            ),
            CapabilityView(
                name="final",
                available=self.settings.matlow_10eros_max_file.is_file(),
                experimental=True,
                reason=(None if self.settings.matlow_10eros_max_file.is_file() else "10Eros Max beta5 W4A8 quality checkpoint is not installed"),
            ),
            CapabilityView(
                name="kitchen_int8",
                available=configured,
                experimental=True,
                reason=("comfy-kitchen CUDA self-test is mandatory; there is no automatic BF16 fallback"),
            ),
            CapabilityView(name="video_inpaint", available=False, reason="Not supported by this MVP"),
            CapabilityView(
                name="automatic_tracking", available=False, reason="No tracking adapter is configured"
            ),
            CapabilityView(
                name="resample",
                available=False,
                reason="H3-Regenerate-2K is outside this local checkpoint",
            ),
            CapabilityView(
                name="style_transfer",
                available=False,
                experimental=True,
                reason="H3 Ref2VA is a semantic/subject reference mechanism; neutral full-clip A/B has not validated reliable style transfer",
            ),
        ]

    async def ready(self) -> tuple[bool, str | None]:
        error = self._configuration_error()
        if error:
            return False, error
        try:
            status = await asyncio.to_thread(self._runtime().probe)
        except Exception as exc:
            return False, f"MATLOWAI runtime probe failed: {type(exc).__name__}: {exc}"
        return bool(status.get("ready")), status.get("reason")

    async def execute(
        self,
        request: GenerateRequest,
        work_dir: Path,
        progress: ProgressCallback,
    ) -> list[BackendOutput]:
        if request.task not in {"t2va", "fl2va", "ref2va"}:
            raise CapabilityUnavailable(
                request.requested_capability,
                "matlow_int8 accepts T2VA, FL2VA and visual Ref2VA only",
            )
        if request.task == "ref2va" and any(condition.get("type") not in {"image", "video"} for condition in request.conditions):
            raise CapabilityUnavailable(
                "ref2va",
                "Local Ref2VA accepts image and video references only; audio references are not enabled",
            )
        if not self._model_path(request.model_variant).is_file():
            raise CapabilityUnavailable(
                request.requested_capability,
                f"H3 model weights are not installed for {request.model_variant}",
            )
        if request.model_variant == "h3_base" and request.quality_mode != "preview":
            raise CapabilityUnavailable(
                "final",
                "matlow_int8 exposes only the GPU-verified local_fast preview profile; "
                "local_quality will be added after a real benchmark",
            )
        if request.model_variant == "h3_base" and request.num_inference_steps not in {None, 4}:
            raise CapabilityUnavailable(
                "preview", "local_fast is pinned to the checkpoint's documented 4 denoise steps"
            )

        error = self._configuration_error()
        if error:
            raise CapabilityUnavailable("fl2va", error)

        runtime = self._runtime()
        work_dir.mkdir(parents=True, exist_ok=True)
        outputs: list[BackendOutput] = []
        await progress(0.02, "runtime_probe")
        status = await asyncio.to_thread(runtime.probe)
        if not status.get("ready"):
            raise CapabilityUnavailable("kitchen_int8", status.get("reason") or "CUDA probe failed")

        try:
            loop = asyncio.get_running_loop()

            def report(value: float, stage: str) -> None:
                asyncio.run_coroutine_threadsafe(progress(value, stage), loop)

            for index in range(request.num_outputs_per_prompt):
                await progress(0.05, "loading_models")
                output_path = work_dir / f"variant-{index}.mp4"
                result = await asyncio.to_thread(runtime.generate, request, output_path, index, report)
                await progress(0.9, "persisting_result")
                outputs.append(
                    BackendOutput(
                        path=output_path,
                        filename=f"h3-matlow-{request.seed or 0}-{index}.mp4",
                        mime_type="video/mp4",
                        metadata=ResultMetadata(
                            backend=self.name,
                            backend_version=self.version,
                            model_revision=result.get("model_revision", MODEL_REVISION),
                            variant=request.model_variant,
                            gpu=result.get("gpu"),
                            vram_gib=result.get("vram_gib"),
                            resolution=result.get("resolution"),
                            frames=result.get("frames"),
                            duration_seconds=result.get("duration_seconds"),
                            steps=result.get("steps", request.effective_steps),
                            seed=result.get("seed"),
                            quantization=f"comfy_quant:{result.get('quantization', 'int8_convrot')}",
                            attention_backend=result.get("attention_backend", "dense"),
                            vae_tile_size=result.get("vae_tile_size"),
                            lora={"enabled": bool(result.get("fused_turbo")), "kind": "fused_turbo" if result.get("fused_turbo") else "none"},
                            render_time_seconds=result["render_time_seconds"],
                            peak_vram_gib=result.get("peak_vram_gib"),
                            peak_ram_gib=result.get("peak_ram_gib"),
                            peak_system_ram_gib=result.get("peak_system_ram_gib"),
                            peak_swap_gib=result.get("peak_swap_gib"),
                            peak_swap_growth_gib=result.get("peak_swap_growth_gib"),
                            model_load_seconds=result.get("model_load_seconds"),
                            text_encoder_seconds=result.get("text_encoder_seconds"),
                            diffusion_seconds=result.get("diffusion_seconds"),
                            vae_decode_seconds=result.get("vae_decode_seconds"),
                            audio_seconds=result.get("audio_seconds"),
                            kernel=result.get("kernel"),
                            input_bytes=result.get("input_bytes", 0),
                            output_bytes=output_path.stat().st_size,
                            verified_gpu_inference=True,
                        ),
                    )
                )
        except asyncio.CancelledError:
            runtime.cancel()
            raise
        except Exception as exc:
            message = str(exc) or type(exc).__name__
            lowered = message.lower()
            resource_failure = (
                "out of memory" in lowered
                or "swap" in lowered
                or "device not ready" in lowered
                or "make resident" in lowered
            )
            raise BackendFailure(
                "resource_exhausted" if resource_failure else "backend_runtime_error",
                message,
                retryable=True,
            ) from exc
        return outputs
