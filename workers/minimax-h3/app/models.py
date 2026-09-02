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
]


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
            frames = sorted(item.get("frame_index") for item in self.conditions)
            if any(item.get("type") != "image" or item.get("role") != "keyframe" for item in self.conditions):
                raise ValueError("fl2va accepts keyframe images only")
            if frames not in ([], [-1], [0], [-1, 0]):
                raise ValueError("fl2va frame_index must be 0, -1, or both")
        if self.task == "ref2va" and not self.conditions:
            raise ValueError("ref2va requires at least one reference")
        if self.quality_mode == "preview":
            steps = self.num_inference_steps or (9 if self.turbo_lora else 8)
            if not 4 <= steps <= 10:
                raise ValueError("preview requires 4-10 sigma steps")
        elif self.num_inference_steps is not None and not 20 <= self.num_inference_steps <= 40:
            raise ValueError("final requires 20-40 sigma steps")
        return self

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
        return "ref2va" if self.task == "ref2va" else "fl2va"

    def sglang_payload(self) -> dict[str, Any]:
        steps = self.num_inference_steps or (
            9
            if self.quality_mode == "preview" and self.turbo_lora
            else 8
            if self.quality_mode == "preview"
            else 30
        )
        return {
            "model": "MiniMaxAI/MiniMax-H3",
            "task": self.task,
            "prompt": self.prompt.strip(),
            "conditions": self.conditions,
            "target": self.target.model_dump() if self.target else None,
            "seed": self.seed,
            "num_outputs_per_prompt": self.num_outputs_per_prompt,
            "num_inference_steps": steps,
            "quality": self.quality,
            **({"lora_scale": self.lora_scale} if self.turbo_lora else {}),
        }


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
    gpu: str | None = None
    vram_gib: float | None = None
    resolution: str | None = None
    frames: int | None = None
    duration_seconds: float | None = None
    steps: int | None = None
    seed: int | None = None
    quantization: str | None = None
    attention_backend: str | None = None
    lora: dict[str, Any] | None = None
    render_time_seconds: float
    peak_vram_gib: float | None = None
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
