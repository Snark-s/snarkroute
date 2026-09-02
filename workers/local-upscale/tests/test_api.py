from __future__ import annotations

from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app
from app.service import UpscaleService


def png_bytes(mode: str = "RGB") -> bytes:
    buffer = BytesIO()
    Image.new(mode, (6, 5), (1, 2, 3, 128) if mode == "RGBA" else (1, 2, 3)).save(buffer, format="PNG")
    return buffer.getvalue()


def wait_for_terminal(client: TestClient, job_id: str, headers: dict[str, str]) -> dict:
    for _ in range(100):
        job = client.get(f"/v1/jobs/{job_id}", headers=headers).json()
        if job["status"] in {"succeeded", "failed", "cancelled"}:
            return job
        import time

        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_capabilities_validation_and_mock_inference(settings):
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer test-token"}
        capabilities = client.get("/v1/capabilities", headers=headers).json()
        assert capabilities["api_cost"] == 0
        assert all(model["weights_installed"] for model in capabilities["models"])
        assert {item["id"] for item in capabilities["parameters"]} >= {"scale", "tile_size", "tile_overlap", "device"}

        upload = client.post("/v1/assets", headers={**headers, "Content-Type": "image/png", "X-Filename": "in.png"}, content=png_bytes("RGBA"))
        assert upload.status_code == 200
        created = client.post("/v1/jobs", headers=headers, json={"model": "4x-realesrgan-x4plus", "input_asset": upload.json()["id"], "scale": 4, "tile_size": 64, "tile_overlap": 8})
        assert created.status_code == 200
        job = wait_for_terminal(client, created.json()["id"], headers)
        assert job["status"] == "succeeded"
        content = client.get(f"/v1/jobs/{job['id']}/content", headers=headers)
        assert content.status_code == 200
        assert content.headers["content-type"] == "image/png"


def test_invalid_input_model_and_missing_weights_are_structured(settings):
    client = TestClient(create_app(settings))
    headers = {"Authorization": "Bearer test-token"}
    unauthorized = client.get("/v1/capabilities")
    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "unauthorized"
    invalid = client.post("/v1/jobs", headers=headers, json={"model": "missing", "input_asset": "asset_missing"})
    assert invalid.status_code == 404
    assert invalid.json()["error"]["code"] == "invalid_model_id"
    bad_upload = client.post("/v1/assets", headers={**headers, "Content-Type": "image/png"}, content=b"not-png")
    assert bad_upload.status_code == 400
    assert bad_upload.json()["error"]["code"] == "invalid_input"

    real_settings = settings.__class__(**{**settings.__dict__, "runtime_override": "pytorch"})
    service = UpscaleService(real_settings)
    asset = service.store_asset(png_bytes(), "in.png", "image/png")
    missing = TestClient(create_app(real_settings, service)).post("/v1/jobs", headers=headers, json={"model": "4x-realesrgan-x4plus", "input_asset": asset["id"]})
    assert missing.status_code == 409
    assert missing.json()["error"]["code"] == "missing_weights"


def test_cancellation_stops_before_later_tiles(settings, monkeypatch):
    service = UpscaleService(settings)
    client = TestClient(create_app(settings, service))
    headers = {"Authorization": "Bearer test-token"}
    asset = service.store_asset(png_bytes(), "in.png", "image/png")

    def slow_process(*args, **kwargs):
        import time

        cancelled = args[-1]
        for _ in range(50):
            if cancelled():
                from app.errors import WorkerError

                raise WorkerError("cancelled", "cancelled")
            time.sleep(0.005)
        return {}

    monkeypatch.setattr("app.service.process_image", slow_process)
    created = client.post("/v1/jobs", headers=headers, json={"model": "4x-realesrgan-x4plus", "input_asset": asset["id"], "tile_size": 64}).json()
    cancelled = client.post(f"/v1/jobs/{created['id']}/cancel", headers=headers).json()
    assert cancelled["status"] == "cancelled"
