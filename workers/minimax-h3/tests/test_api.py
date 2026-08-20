import time

from fastapi.testclient import TestClient


def generation_payload() -> dict:
    return {
        "operation": "video.generate.h3",
        "task": "t2va",
        "prompt": "contract test",
        "target": {"short_edge": 768, "aspect_ratio": "1:1", "duration_seconds": 4},
        "seed": 7,
        "num_inference_steps": 20,
        "quality_mode": "final",
    }


def wait_for_terminal(client: TestClient, job_id: str, headers: dict[str, str]) -> dict:
    for _ in range(100):
        response = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert response.status_code == 200
        job = response.json()
        if job["status"] in {"succeeded", "failed", "cancelled"}:
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_health_readiness_and_auth(configured_app, auth_headers):
    with TestClient(configured_app) as client:
        assert client.get("/health").json()["ok"] is True
        assert client.get("/ready").status_code == 401
        ready = client.get("/ready", headers=auth_headers)
        assert ready.status_code == 200
        assert ready.json() == {
            "ready": True,
            "backend": "mock",
            "backendVersion": "1",
            "reason": "mock backend; contract checks only",
            "activeJobs": 0,
        }
        capabilities = client.get("/v1/capabilities", headers=auth_headers).json()
        assert capabilities["mock"] is True
        assert (
            next(item for item in capabilities["capabilities"] if item["name"] == "video_inpaint")[
                "available"
            ]
            is False
        )


def test_mock_job_idempotency_result_and_metadata(configured_app, auth_headers):
    with TestClient(configured_app) as client:
        headers = {**auth_headers, "Idempotency-Key": "contract-job-1"}
        first = client.post("/v1/jobs", headers=headers, json=generation_payload())
        duplicate = client.post("/v1/jobs", headers=headers, json=generation_payload())
        assert first.status_code == duplicate.status_code == 202
        assert first.json()["id"] == duplicate.json()["id"]
        job = wait_for_terminal(client, first.json()["id"], auth_headers)
        assert job["status"] == "succeeded"
        assert job["metadata"]["backend"] == "mock"
        assert job["metadata"]["verified_gpu_inference"] is False
        result = client.get(f"/v1/jobs/{job['id']}/result", headers=auth_headers)
        assert result.status_code == 200
        content = client.get(f"/v1/jobs/{job['id']}/content", headers=auth_headers)
        assert content.status_code == 200
        assert content.content.startswith(b"SNARKROUTE-H3-MOCK")


def test_idempotency_conflict(configured_app, auth_headers):
    with TestClient(configured_app) as client:
        headers = {**auth_headers, "Idempotency-Key": "same-key"}
        assert client.post("/v1/jobs", headers=headers, json=generation_payload()).status_code == 202
        changed = generation_payload()
        changed["seed"] = 8
        response = client.post("/v1/jobs", headers=headers, json=changed)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "idempotency_conflict"


def test_inpaint_contract_is_honest_about_unavailable_sampling(configured_app, auth_headers):
    payload = {
        "operation": "video.inpaint.h3",
        "task": "video_inpaint",
        "inpaint": {
            "source_video": {"uri": "https://example.com/source.mp4"},
            "mask": {"uri": "https://example.com/mask.mp4"},
            "reference_image": {"uri": "https://example.com/reference.png"},
            "prompt": "replace subject",
            "audio_mode": "preserve",
            "crop_padding": 64,
            "denoise": 0.7,
            "steps": 30,
            "seed": 1,
            "quality": "final",
        },
    }
    with TestClient(configured_app) as client:
        response = client.post("/v1/jobs", headers=auth_headers, json=payload)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "capability_not_available"


def test_upload_checks_size_type_and_magic(configured_app, auth_headers):
    with TestClient(configured_app) as client:
        invalid = client.post(
            "/v1/assets", headers={**auth_headers, "Content-Type": "image/png"}, content=b"not png"
        )
        assert invalid.status_code == 415
        unsupported = client.post(
            "/v1/assets", headers={**auth_headers, "Content-Type": "text/plain"}, content=b"x"
        )
        assert unsupported.status_code == 415
        mp4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isom"
        accepted = client.post(
            "/v1/assets", headers={**auth_headers, "Content-Type": "video/mp4"}, content=mp4
        )
        assert accepted.status_code == 201
        assert accepted.json()["uri"].startswith("file:///")
