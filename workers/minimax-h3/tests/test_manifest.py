import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from manifest import default_manifest, load_manifest  # noqa: E402
from verify_models import local_component_bytes  # noqa: E402


def test_manifest_is_pinned_and_marks_unknowns_honestly():
    manifest = load_manifest(default_manifest())
    assert manifest["model"]["revision"] == "42ed227ee7df40d41602854ae760620d6eb651fe"
    assert manifest["frameworks"]["sglang"]["commit"] == ("3f26febaff04bac4cfefd60bdc9097bc26a96cb8")
    assert manifest["frameworks"]["comfy_kitchen"]["version"] == "0.2.31"
    assert manifest["frameworks"]["comfy_kitchen"]["required_dependencies"] == []
    components = {item["id"]: item for item in manifest["components"]}
    assert components["h3-base-fl2va"]["expected_bytes"] > 100_000_000_000
    assert components["h3-clip-proj"]["filename"] == "unresolved"
    assert components["h3-turbo-lora-4-eval"]["download"] is False


def test_comfy_kitchen_is_isolated_to_cuda_image_without_comfyui():
    root = Path(__file__).resolve().parents[1]
    api_runtime_files = [
        root / "requirements.txt",
        root / "pyproject.toml",
        root / "Dockerfile",
    ]
    api_runtime = "\n".join(path.read_text(encoding="utf-8").lower() for path in api_runtime_files)
    cuda_runtime = "\n".join(
        (root / name).read_text(encoding="utf-8").lower()
        for name in ("Dockerfile.sglang", "requirements.sglang.txt")
    )
    assert "comfyui" not in api_runtime + cuda_runtime
    assert "comfy-kitchen" not in api_runtime
    assert "comfy-kitchen==0.2.31" in cuda_runtime
    assert "--require-hashes" in cuda_runtime


def test_local_component_size_includes_root_model_index(tmp_path: Path):
    root = tmp_path / "MiniMax-H3"
    variant = root / "FL2VA"
    variant.mkdir(parents=True)
    (root / "model_index.json").write_bytes(b"root")
    (variant / "weights.bin").write_bytes(b"weights")
    assert local_component_bytes(root, "FL2VA") == 11
