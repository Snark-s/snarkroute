import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

MODULE_PATH = Path(__file__).with_name("snarkdeploy.py")
SPEC = importlib.util.spec_from_file_location("snarkdeploy", MODULE_PATH)
SNARKDEPLOY = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(SNARKDEPLOY)


class SnarkDeployTests(unittest.TestCase):
    def test_verify_rejects_windows_and_posix_archive_traversal(self):
        for member in ('files/demo/../../outside.txt', 'files/demo/..\\outside.txt',
                       '/outside.txt', 'C:/outside.txt', 'files/demo/file.txt:stream'):
            with self.subTest(member=member), tempfile.TemporaryDirectory() as temp:
                bundle = Path(temp) / 'recovery.zip'
                with zipfile.ZipFile(bundle, 'w') as archive:
                    for name, value in [('state.json', '{"components":[]}'), ('manifest.json', '{}'),
                                        ('system.json', '{}'), ('heavy-inventory.json', '[]'), (member, 'payload')]:
                        archive.writestr(name, value)
                with self.assertRaisesRegex(RuntimeError, 'unsafe archive'):
                    SNARKDEPLOY.verify_bundle(bundle, quiet=True)

    def test_restore_refuses_symlink_destination_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target, outside = root/'target', root/'outside'
            target.mkdir()
            outside.mkdir()
            try:
                (target/'redirect').symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('Symlink creation requires OS permission')
            with self.assertRaisesRegex(RuntimeError, 'escapes restore target'):
                SNARKDEPLOY.restore_destination(target, 'redirect/file.txt')

    def test_restored_registry_and_pointer_follow_new_roots(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            route = root / 'SnarkRoute'
            route.mkdir()
            registry = {'schemaVersion':1,'host':'127.0.0.1','services':{
                'snarkroute': {'port':24317,'protocol':'http','healthPath':'/health'}}}
            (route / 'service-endpoints.json').write_text(json.dumps(registry), encoding='utf-8')
            variables = {name:{'default':str(root / name)} for name in [
                'SNARK_MIXAR_BACKEND','SNARK_MIXAR_SOURCE','SNARK_MIXAR_PROFILE','PERSONA_HOME','SNARKBRIDGE_ROOT','SNARK_BONSAI']}
            variables['SNARKROUTE_ROOT'] = {'default':str(route)}
            variables['SNARK_REGISTRY_PATH'] = {'default':str(root / 'service-registry.json')}
            manifest = {'variables':variables,'services':[{'id':'snarkroute','registry_service':'snarkroute'}]}
            with patch.dict(SNARKDEPLOY.os.environ, {'LOCALAPPDATA':str(root / 'LocalAppData')}, clear=True):
                generated = SNARKDEPLOY.write_registry(manifest)
            self.assertEqual(json.loads(generated.read_text())['services'][0]['endpoint'], 'http://127.0.0.1:24317')
            canonical = json.loads((route / 'service-endpoints.json').read_text())
            self.assertEqual(canonical['paths']['snarkroute'], str(route))
            pointer = root / 'LocalAppData/SnarkDream/service-endpoints.path'
            self.assertEqual(pointer.read_text(), str((route / 'service-endpoints.json').resolve()))

    def test_service_inventory_uses_authoritative_ports(self):
        registry = {'schemaVersion': 1, 'host': '127.0.0.1', 'services': {
            'bonsai_inference': {'port': 18081, 'protocol': 'http', 'healthPath': '/v1/models'},
        }}
        manifest = {'variables': {}, 'services': [{
            'id': 'bonsai-local', 'registry_service': 'bonsai_inference', 'endpoint': 'http://127.0.0.1:8080/v1',
        }]}
        item = SNARKDEPLOY.resolved_services(manifest, registry)[0]
        self.assertEqual(item['endpoint'], 'http://127.0.0.1:18081')
        self.assertEqual(item['probe']['path'], '/v1/models')

    def test_http_probe_rejects_success_from_foreign_service(self):
        class Reply:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): return b'{"service":"foreign","apiVersion":1}'
        with patch.object(SNARKDEPLOY.urllib.request.OpenerDirector, 'open', return_value=Reply()):
            ok, detail = SNARKDEPLOY.probe_http('http://127.0.0.1:4317/health', identity={'field':'service','value':'snarkroute-server'}, api_version=1)
        self.assertFalse(ok)
        self.assertIn('identity', detail)

    def test_http_probe_requires_exact_status_200(self):
        class Reply:
            status = 404
            def __enter__(self): return self
            def __exit__(self, *args): pass
        with patch.object(SNARKDEPLOY.urllib.request.OpenerDirector, 'open', return_value=Reply()):
            self.assertFalse(SNARKDEPLOY.probe_http('http://127.0.0.1:4317/health')[0])

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

    def test_git_bundle_unshallows_source_and_restores_full_commit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            origin_work = root / "origin-work"
            origin_work.mkdir()
            subprocess.run(["git", "init"], cwd=origin_work, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=origin_work, check=True)
            subprocess.run(["git", "config", "user.name", "SnarkDeploy Test"], cwd=origin_work, check=True)

            tracked = origin_work / "tracked.txt"
            tracked.write_text("first\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.txt"], cwd=origin_work, check=True)
            subprocess.run(["git", "commit", "-m", "first"], cwd=origin_work, check=True, capture_output=True)
            tracked.write_text("second\n", encoding="utf-8")
            subprocess.run(["git", "commit", "-am", "second"], cwd=origin_work, check=True, capture_output=True)

            origin_bare = root / "origin.git"
            subprocess.run(["git", "clone", "--bare", str(origin_work), str(origin_bare)], check=True, capture_output=True)

            shallow = root / "shallow"
            origin_url = origin_bare.resolve().as_uri()
            subprocess.run(
                ["git", "clone", "--depth=1", origin_url, str(shallow)],
                check=True,
                capture_output=True,
            )
            self.assertEqual(
                subprocess.run(
                    ["git", "rev-parse", "--is-shallow-repository"],
                    cwd=shallow,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
                "true",
            )
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=shallow,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

            bundle = root / "shallow.bundle"
            meta = SNARKDEPLOY.create_git_bundle(shallow, commit, bundle)
            self.assertEqual(
                subprocess.run(
                    ["git", "rev-parse", "--is-shallow-repository"],
                    cwd=shallow,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
                "false",
            )

            restored = root / "restored"
            restored.mkdir()
            subprocess.run(["git", "init"], cwd=restored, check=True, capture_output=True)
            SNARKDEPLOY.fetch_git_bundle(restored, bundle, meta["ref"])
            subprocess.run(
                ["git", "checkout", "--detach", commit],
                cwd=restored,
                check=True,
                capture_output=True,
            )
            self.assertEqual((restored / "tracked.txt").read_text(encoding="utf-8"), "second\n")
            history = subprocess.run(
                ["git", "rev-list", "--count", commit],
                cwd=restored,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            self.assertEqual(history, "2")

    def test_restore_dry_run_uses_bundle_manifest_for_new_component(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bundle = root / "recovery.zip"
            target = root / "future-component"
            manifest = {
                "variables": {
                    "FUTURE_COMPONENT": {"default": str(target)},
                },
                "components": [
                    {
                        "id": "future-component",
                        "label": "Future component",
                        "path": "{{FUTURE_COMPONENT}}",
                        "strategy": "copy",
                        "snapshot": True,
                    }
                ],
                "services": [],
            }
            state = {
                "components": [
                    {
                        "id": "future-component",
                        "path": r"C:\OldMachine\Future",
                        "strategy": "copy",
                        "present": True,
                        "mode": "copy",
                    }
                ]
            }
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("state.json", json.dumps(state))
                archive.writestr("manifest.json", json.dumps(manifest))
                archive.writestr("system.json", "{}")
                archive.writestr("heavy-inventory.json", "[]")

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = SNARKDEPLOY.restore(SimpleNamespace(bundle=str(bundle), dry_run=True))

            self.assertEqual(code, 0)
            self.assertIn("future-component: copy", output.getvalue())
            self.assertIn(str(target), output.getvalue())
            self.assertNotIn("skip unknown component", output.getvalue())


if __name__ == "__main__":
    unittest.main()
