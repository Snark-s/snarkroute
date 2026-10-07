import ipaddress
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
CapabilityName = Literal[
    "fl2va",
    "ref2va",
    "video_inpaint",
    "resample",
    "preview",
    "final",
    "automatic_tracking",
    "kitchen_int8",
    "style_transfer",
    "identity_transfer",
    "visual_lora",
    "camera_prompt_control",
]

H3ModelVariant = Literal["h3_base", "10eros_max", "10eros_max_turbo"]


class IdentityTransfer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: Literal[True] = True
    strength: float = Field(default=1.0, ge=0, le=2)


class VisualModifier(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["authentic_cinematic_texture"]
    enabled: Literal[True] = True
    strength: float = Field(default=0.7, ge=0, le=2)
    include_trigger: bool = False


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid")
    short_edge: Literal[768] = 768
    aspect_ratio: str = Field(default="auto", pattern=r"^(auto|21:9|16:9|4:3|1:1|3:4|9:16)$")
    duration_seconds: float = Field(ge=4, le=15)


class AssetReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    uri: str = Field(min_length=1, max_length=4096)
    mime_type: str | None = Field(default=None, max_length=128)

    @field_validator("uri")
    @classmethod
    def safe_uri(cls, value: str) -> str:
        parsed = urlparse(value)
        if parsed.scheme not in {"https", "http", "file"}:
            raise ValueError("asset URI must use http(s) or worker-local file:///")
        if parsed.scheme in {"http", "https"}:
            hostname = (parsed.hostname or "").lower()
            if not hostname or hostname == "localhost" or hostname.endswith(".local"):
                raise ValueError("asset URI must not target a local host")
            try:
                address = ipaddress.ip_address(hostname)
            except ValueError:
                address = None
            if address and (address.is_private or address.is_loopback or address.is_link_local):
                raise ValueError("asset URI must not target a private address")
        decoded = unquote(parsed.path)
        if ".." in decoded.split("/"):
            raise ValueError("asset URI must not contain path traversal")
        if parsed.scheme == "file" and (parsed.netloc or not parsed.path.startswith("/")):
            raise ValueError("file URI must be absolute and local")
        return value


class InpaintInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_video: AssetReference
    mask: AssetReference | None = None
    selected_subject: str | None = Field(default=None, min_length=1, max_length=500)
    reference_image: AssetReference
    prompt: str = Field(min_length=1, max_length=20_000)
    audio_mode: Literal["preserve", "regenerate_region", "replace_dialogue"] = "preserve"
    crop_padding: int = Field(default=64, ge=0, le=512)
    denoise: float = Field(default=0.7, ge=0, le=1)
    steps: int = Field(default=30, ge=4, le=40)
    seed: int = Field(default=0, ge=0, le=2_147_483_647)
    quality: Literal["preview", "final"] = "final"

    @model_validator(mode="after")
    def require_mask_source(self) -> "InpaintInput":
        if not self.mask and not self.selected_subject:
            raise ValueError("video inpaint requires mask or selected_subject")
        return self


class ResampleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_video: AssetReference
    prompt: str = Field(min_length=1, max_length=20_000)
    target_resolution: Literal["2k"] = "2k"
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["video.generate.h3", "video.inpaint.h3", "video.resample.h3"] = "video.generate.h3"
    task: Literal["t2va", "fl2va", "ref2va", "video_inpaint", "resample"] = "t2va"
    prompt: str = Field(default="", max_length=20_000)
    conditions: list[dict[str, Any]] = Field(default_factory=list, max_length=12)
    target: Target | None = None
    inpaint: InpaintInput | None = None
    resample: ResampleInput | None = None
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    num_outputs_per_prompt: int = Field(default=1, ge=1, le=10)
    num_inference_steps: int | None = Field(default=None, ge=4, le=40)
    quality_mode: Literal["preview", "final"] = "final"
    quality: Literal["lossless", "high"] = "lossless"
    turbo_lora: bool = False
    lora_scale: float = Field(default=1.0, ge=0, le=2)
    model_variant: H3ModelVariant = "h3_base"
    attention_mode: Literal["auto", "veda", "dense"] | None = None
    identity_transfer: IdentityTransfer | None = None
    visual_modifier: VisualModifier | None = None
    camera_path: dict[str, Any] | None = None
    camera_control_mode: Literal["prompt"] | None = None
    idempotency_key: str | None = Field(
        default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
    )
    timeout_seconds: int | None = Field(default=None, ge=30, le=7200)

    @field_validator("conditions")
    @classmethod
    def validate_conditions(cls, conditions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        counts = {"image": 0, "video": 0, "video_audio": 0, "audio": 0}
        for condition in conditions:
            kind = condition.get("type")
            uri = condition.get("uri")
            if kind not in counts or not isinstance(uri, str):
                raise ValueError("every condition needs a supported type and URI")
            AssetReference(uri=uri)
            counts[kind] += 1
        if counts["image"] > 9 or counts["video"] + counts["video_audio"] > 3 or counts["audio"] > 3:
            raise ValueError("reference limits exceeded")
        return conditions

    @model_validator(mode="after")
    def validate_shape(self) -> "GenerateRequest":
        if self.operation == "video.inpaint.h3" or self.task == "video_inpaint":
            if not self.inpaint:
                raise ValueError("video.inpaint.h3 requires inpaint inputs")
            return self
        if self.operation == "video.resample.h3" or self.task == "resample":
            if not self.resample:
                raise ValueError("video.resample.h3 requires resample inputs")
            return self
        if not self.prompt.strip() or not self.target:
            raise ValueError("generation requires prompt and target")
        if self.task == "t2va" and self.conditions:
            raise ValueError("t2va does not accept conditions")
        if self.task == "fl2va":
            if any(item.get("type") != "image" or item.get("role") != "keyframe" for item in self.conditions):
                raise ValueError("fl2va accepts keyframe images only")
            frames = sorted(item.get("frame_index") for item in self.conditions)
            if frames not in ([], [-1], [0], [-1, 0]):
                raise ValueError("fl2va frame_index must be 0, -1, or both")
        if self.task == "ref2va" and not self.conditions:
            raise ValueError("ref2va requires at least one reference")
        if self.identity_transfer:
            if self.model_variant != "h3_base" or self.task != "ref2va":
                raise ValueError("identity_transfer requires h3_base Ref2VA")
            if not any(item.get("type") == "video" for item in self.conditions):
                raise ValueError("identity_transfer requires a reference video")
            if not any(item.get("type") == "image" and item.get("purpose") == "identity" for item in self.conditions):
                raise ValueError("identity_transfer requires an image marked purpose=identity")
        if self.visual_modifier:
            if self.model_variant != "h3_base":
                raise ValueError("visual_modifier requires h3_base")
            if self.identity_transfer:
                raise ValueError("visual_modifier cannot be combined with identity_transfer until controlled-tested")
        if self.camera_path is not None and self.camera_control_mode != "prompt":
            raise ValueError("local H3 accepts CameraPath only through camera_control_mode=prompt")
        if self.model_variant == "10eros_max" and self.quality_mode != "final":
            raise ValueError("10eros_max is the quality/final profile")
        if self.model_variant == "10eros_max_turbo" and self.quality_mode != "preview":
            raise ValueError("10eros_max_turbo is the fast/preview profile")
        if self.model_variant == "10eros_max":
            steps = self.num_inference_steps or 8
            if not 4 <= steps <= 8:
                raise ValueError("10eros_max requires 4-8 sigma steps")
        elif self.model_variant == "10eros_max_turbo":
            steps = self.num_inference_steps or 6
            if not 4 <= steps <= 8:
                raise ValueError("10eros_max_turbo requires 4-8 sigma steps")
        elif self.quality_mode == "preview":
            steps = self.num_inference_steps or (9 if self.turbo_lora else 8)
            if not 4 <= steps <= 10:
                raise ValueError("preview requires 4-10 sigma steps")
        elif self.num_inference_steps is not None and not 20 <= self.num_inference_steps <= 40:
            raise ValueError("final requires 20-40 sigma steps")
        return self

    @property
    def effective_steps(self) -> int:
        if self.num_inference_steps is not None:
            return self.num_inference_steps
        if self.model_variant == "10eros_max":
            return 8
        if self.model_variant == "10eros_max_turbo":
            return 6
        return 8 if self.quality_mode == "preview" else 30

    @property
    def requested_capability(self) -> str:
        if self.operation == "video.inpaint.h3" or self.task == "video_inpaint":
            return (
                "automatic_tracking"
                if self.inpaint and self.inpaint.selected_subject and not self.inpaint.mask
                else "video_inpaint"
            )
        if self.operation == "video.resample.h3" or self.task == "resample":
            return "resample"
        if self.identity_transfer:
            return "identity_transfer"
        return "ref2va" if self.task == "ref2va" else "fl2va"

    @property
    def effective_prompt(self) -> str:
        prompt = self.prompt.strip()
        if self.identity_transfer and "faceswap" not in prompt.lower():
            prompt = f"Faceswap, {prompt}"
        if self.visual_modifier and self.visual_modifier.include_trigger:
            tokens = {token.strip(" ,.").lower() for token in prompt.split()}
            if "dy" not in tokens:
                prompt = f"DY, {prompt}"
        return prompt


class StructuredError(BaseModel):
    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] | None = None


class ResultMetadata(BaseModel):
    backend: str
    backend_version: str
    model_revision: str
    variant: str
    model_variant: str | None = None
    gpu: str | None = None
    vram_gib: float | None = None
    resolution: str | None = None
    frames: int | None = None
    duration_seconds: float | None = None
    steps: int | None = None
    seed: int | None = None
    quantization: str | None = None
    sampler: str | None = None
    scheduler: str | None = None
    flow_parameters: dict[str, Any] | None = None
    guidance: dict[str, Any] | None = None
    attention_backend: str | None = None
    attention: dict[str, Any] | None = None
    vae_tile_size: int | None = None
    lora: dict[str, Any] | None = None
    references: dict[str, Any] | None = None
    conditioning: dict[str, Any] | None = None
    render_time_seconds: float
    peak_vram_gib: float | None = None
    peak_ram_gib: float | None = None
    peak_system_ram_gib: float | None = None
    peak_swap_gib: float | None = None
    peak_swap_growth_gib: float | None = None
    model_load_seconds: float | None = None
    text_encoder_seconds: float | None = None
    diffusion_seconds: float | None = None
    vae_decode_seconds: float | None = None
    audio_seconds: float | None = None
    kernel: str | None = None
    input_bytes: int = 0
    output_bytes: int
    verified_gpu_inference: bool = False


class OutputView(BaseModel):
    index: int
    filename: str
    mime_type: str
    bytes: int
    storage_backend: str
    storage_key: str


class JobView(BaseModel):
    id: str
    status: JobStatus
    stage: str
    progress: float | None = None
    error: StructuredError | None = None
    outputs: list[OutputView] = Field(default_factory=list)
    metadata: ResultMetadata | None = None
    created_at: str
    updated_at: str
    started_at: str | None = None
    completed_at: str | None = None


class CapabilityView(BaseModel):
    name: CapabilityName
    available: bool
    experimental: bool = False
    reason: str | None = None
