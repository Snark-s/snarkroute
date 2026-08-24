from __future__ import annotations

from app.registry import ModelRegistry
from app.video_registry import VideoModelRegistry


def test_openmodeldb_temporal_models_are_pinned_and_distinct() -> None:
    models = {model.id: model for model in VideoModelRegistry.load(ModelRegistry.load()).list()}
    selected = {
        "openmodeldb/gameup-v2-tscunet-small-x2",
        "openmodeldb/vimeoscale-unet-x2",
        "openmodeldb/redsval-7f-rrdb-lite-x4",
        "openmodeldb/video-tssm-x3",
    }

    assert selected <= models.keys()
    assert {models[model_id].architecture_family for model_id in selected} == {"TSCUNet", "SOFVSR"}
    assert {models[model_id].native_scale for model_id in selected} == {2, 3, 4}
    assert all(models[model_id].temporal for model_id in selected)
    assert all(models[model_id].context_frames in {3, 5, 7} for model_id in selected)
    assert all(models[model_id].inference_mode == "center-frame" for model_id in selected)
    assert all(models[model_id].source == "OpenModelDB" for model_id in selected)
    assert all(models[model_id].openmodeldb_url.startswith("https://openmodeldb.info/models/") for model_id in selected)
    assert all(models[model_id].resource and len(models[model_id].resource.sha256) == 64 for model_id in selected)


def test_video_registry_preserves_license_restrictions() -> None:
    models = {model.id: model for model in VideoModelRegistry.load(ModelRegistry.load()).list()}

    game = models["openmodeldb/gameup-v2-tscunet-small-x2"]
    animation = models["openmodeldb/video-tssm-x3"]
    natural = models["openmodeldb/vimeoscale-unet-x2"]

    assert game.license == "CC-BY-NC-SA-4.0"
    assert game.commercial_use is False
    assert {"NC", "SA"} <= set(game.license_restrictions)
    assert animation.commercial_use is False
    assert natural.license == "CC-BY-SA-4.0"
    assert natural.commercial_use is True
    assert natural.license_restrictions == ("SA",)
