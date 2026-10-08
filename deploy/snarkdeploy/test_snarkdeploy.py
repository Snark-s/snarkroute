import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("snarkdeploy.py")
SPEC = importlib.util.spec_from_file_location("snarkdeploy", MODULE_PATH)
SNARKDEPLOY = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(SNARKDEPLOY)


class SnarkDeployTests(unittest.TestCase):
    def test_expand_resolves_nested_variables(self):
        variables = {
            "ROOT": {"default": r"C:\Snark"},
            "APP": {"default": r"{{ROOT}}\App"},
        }
        self.assertEqual(SNARKDEPLOY.expand(r"{{APP}}\data", variables), r"C:\Snark\App\data")

    def test_should_exclude_matches_path_parts_and_globs(self):
        self.assertTrue(SNARKDEPLOY.should_exclude("extension/node_modules/a.js", ["node_modules"]))
        self.assertTrue(SNARKDEPLOY.should_exclude("cache/file.tmp", ["*.tmp"]))
        self.assertFalse(SNARKDEPLOY.should_exclude("extension/dist/app.js", ["node_modules", "*.tmp"]))

    def test_verify_bundle_accepts_valid_archive_and_sha256(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "recovery.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("state.json", json.dumps({"components": []}))
                archive.writestr("manifest.json", "{}")
                archive.writestr("system.json", "{}")
                archive.writestr("heavy-inventory.json", "[]")
            digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
            bundle.with_suffix(".zip.sha256").write_text(f"{digest}  recovery.zip\n", encoding="ascii")
            state = SNARKDEPLOY.verify_bundle(bundle, quiet=True)
            self.assertEqual(state["components"], [])

    def test_verify_bundle_rejects_secret_material(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "recovery.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("state.json", json.dumps({"components": []}))
                archive.writestr("manifest.json", "{}")
                archive.writestr("system.json", "{}")
                archive.writestr("heavy-inventory.json", "[]")
                archive.writestr("git/snarkroute/untracked/.env", "SECRET=1")
            with self.assertRaisesRegex(RuntimeError, "forbidden secret material"):
                SNARKDEPLOY.verify_bundle(bundle, quiet=True)

    def test_verify_bundle_rejects_persona_runtime_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "recovery.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("state.json", json.dumps({"components": []}))
                archive.writestr("manifest.json", "{}")
                archive.writestr("system.json", "{}")
                archive.writestr("heavy-inventory.json", "[]")
                archive.writestr("files/personacore/config/secrets.cloud-token", "not-exportable")
            with self.assertRaisesRegex(RuntimeError, "security scan failed"):
                SNARKDEPLOY.verify_bundle(bundle, quiet=True)

    def test_verify_bundle_rejects_literal_token_in_persona_data(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "recovery.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("state.json", json.dumps({"components": []}))
                archive.writestr("manifest.json", "{}")
                archive.writestr("system.json", "{}")
                archive.writestr("heavy-inventory.json", "[]")
                archive.writestr(
                    "files/personacore/data/example.json",
                    '{"API_KEY":"pza_abcdefghijklmnopqrstuvwxyz012345"}',
                )
            with self.assertRaisesRegex(RuntimeError, "security scan failed"):
                SNARKDEPLOY.verify_bundle(bundle, quiet=True)

    def test_git_patch_application_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "SnarkDeploy Test"], cwd=repo, check=True)
            target = repo / "sample.txt"
            target.write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "sample.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True)
            target.write_text("changed\n", encoding="utf-8")
            patch = Path(temp) / "working.patch"
            patch.write_bytes(subprocess.run(
                ["git", "diff", "--binary", "HEAD"],
                cwd=repo,
                check=True,
                capture_output=True,
            ).stdout)
            subprocess.run(["git", "restore", "sample.txt"], cwd=repo, check=True)
            self.assertEqual(SNARKDEPLOY.apply_git_patch_idempotent(repo, patch, "test"), "applied")
            self.assertEqual(target.read_text(encoding="utf-8"), "changed\n")
            self.assertEqual(SNARKDEPLOY.apply_git_patch_idempotent(repo, patch, "test"), "already-applied")

    def test_git_bundle_restores_commit_offline(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.mkdir()
            subprocess.run(["git", "init"], cwd=source, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "SnarkDeploy Test"], cwd=source, check=True)
            tracked = source / "tracked.txt"
            tracked.write_text("offline recovery\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-m", "snapshot"], cwd=source, check=True, capture_output=True)
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=source,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

            bundle = root / "repo.bundle"
            meta = SNARKDEPLOY.create_git_bundle(source, commit, bundle)
            self.assertTrue(bundle.is_file())
            self.assertEqual(meta["sha256"], hashlib.sha256(bundle.read_bytes()).hexdigest())
            self.assertNotEqual(
                subprocess.run(
                    ["git", "show-ref", "--verify", "--quiet", meta["ref"]],
                    cwd=source,
                ).returncode,
                0,
            )

            restored = root / "restored"
            restored.mkdir()
            subprocess.run(["git", "init"], cwd=restored, check=True, capture_output=True)
            SNARKDEPLOY.fetch_git_bundle(restored, bundle, meta["ref"])
            subprocess.run(["git", "checkout", "--detach", commit], cwd=restored, check=True, capture_output=True)
            self.assertEqual((restored / "tracked.txt").read_text(encoding="utf-8"), "offline recovery\n")

    def test_cached_sha256_reuses_unchanged_file_and_invalidates_on_change(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "model.bin"
            target.write_bytes(b"first payload")
            cache = {}
            first, hit = SNARKDEPLOY.cached_sha256(target, target.stat(), cache)
            self.assertFalse(hit)
            second, hit = SNARKDEPLOY.cached_sha256(target, target.stat(), cache)
            self.assertTrue(hit)
            self.assertEqual(first, second)
            target.write_bytes(b"changed payload with different length")
            third, hit = SNARKDEPLOY.cached_sha256(target, target.stat(), cache)
            self.assertFalse(hit)
            self.assertNotEqual(first, third)

    def test_hash_cache_can_seed_from_previous_recovery_inventory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            models = root / "models"
            models.mkdir()
            bundle = root / "snark-recovery-20260101-010101.zip"
            heavy = [{
                "id": "models",
                "root": str(models),
                "files": [{
                    "path": "model.gguf",
                    "bytes": 123,
                    "mtime_ns": 456,
                    "sha256": "a" * 64,
                }],
            }]
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("heavy-inventory.json", json.dumps(heavy))
            cache = {}
            seeded, source = SNARKDEPLOY.seed_hash_cache_from_latest_bundle(root, cache)
            self.assertEqual(seeded, 1)
            self.assertEqual(source, bundle)
            key = SNARKDEPLOY.hash_cache_key(models / "model.gguf")
            self.assertEqual(cache[key]["sha256"], "a" * 64)


if __name__ == "__main__":
    unittest.main()
