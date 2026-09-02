from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models import AssetReference
from app.storage.results import LocalResultStore


@pytest.mark.parametrize(
    "uri",
    [
        "file:///data/results/inputs/a/../../etc/passwd",
        "ftp://example.com/file.mp4",
        "http://127.0.0.1/private",
        "http://10.0.0.1/private",
        "http://localhost/private",
    ],
)
def test_rejects_traversal_and_private_media_uris(uri: str):
    with pytest.raises(ValidationError):
        AssetReference(uri=uri)


def test_local_result_store_confines_generated_names(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"mock")
    store = LocalResultStore(tmp_path / "root")
    stored = store.put("00000000-0000-0000-0000-000000000001", 0, source, "../../escape.mp4", "video/mp4")
    path = store.local_path(stored.key)
    assert path is not None
    assert (tmp_path / "root" / "results").resolve() in path.parents
