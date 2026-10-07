#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST_PATH = HERE / "manifest.json"
CHUNK_SIZE = 8 * 1024 * 1024
SECRET_SCAN_LIMIT = 5 * 1024 * 1024
TEXT_EXTENSIONS = {
    ".json", ".txt", ".md", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".ps1", ".sh", ".bat",
    ".cmd", ".html", ".css", ".xml",
}
HIGH_CONFIDENCE_SECRET_PATTERNS = [
    re.compile(rb"pza_[A-Za-z0-9_-]{20,}"),
    re.compile(rb"ghp_[A-Za-z0-9]{20,}"),
    re.compile(rb"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(rb"hf_[A-Za-z0-9]{20,}"),
    re.compile(rb"AIza[0-9A-Za-z_-]{20,}"),
    re.compile(rb"sk-proj-[A-Za-z0-9_-]{20,}"),
]
LITERAL_SECRET_ASSIGNMENT = re.compile(
    rb"(?i)\b(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)\b"
    rb"[\"' \t]{0,4}[:=][\"' \t]{0,4}([A-Za-z0-9._~+/-]{24,})"
)
FORBIDDEN_BUNDLE_PATHS = [
    re.compile(r"^files/personacore/config/secrets\.", re.I),
    re.compile(r"^files/personacore/data/runtime/agent/tasks/", re.I),
    re.compile(r"^files/personacore/data/runtime/harness/", re.I),
]


def load_manifest():
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def expand(value, variables):
    if not isinstance(value, str):
        return value
    env = dict(os.environ)
    env.setdefault("APPDATA", os.getenv("APPDATA", ""))
    env.setdefault("LOCALAPPDATA", os.getenv("LOCALAPPDATA", ""))
    resolved = value
    merged = {}
    for key, spec in variables.items():
        merged[key] = os.getenv(key) or spec.get("default", "")
    for _ in range(12):
        old = resolved
        for key, raw in merged.items():
            item = str(raw)
            for nested_key, nested_value in merged.items():
                item = item.replace("{{" + nested_key + "}}", str(nested_value))
            item = item.replace("{{APPDATA}}", env["APPDATA"]).replace("{{LOCALAPPDATA}}", env["LOCALAPPDATA"])
            resolved = resolved.replace("{{" + key + "}}", item)
        resolved = resolved.replace("{{APPDATA}}", env["APPDATA"]).replace("{{LOCALAPPDATA}}", env["LOCALAPPDATA"])
        if resolved == old:
            break
    return os.path.expandvars(resolved)


def run(cmd, cwd=None, check=True):
    if isinstance(cmd, str):
        process = subprocess.run(cmd, cwd=cwd, shell=True, text=True, encoding="utf-8", errors="replace", capture_output=True)
    else:
        args = list(cmd)
        resolved = shutil.which(str(args[0])) if args else None
        if os.name == "nt" and resolved and Path(resolved).suffix.lower() in {".cmd", ".bat"}:
            command_line = subprocess.list2cmdline([resolved, *map(str, args[1:])])
            process = subprocess.run(command_line, cwd=cwd, shell=True, text=True, encoding="utf-8", errors="replace", capture_output=True)
        else:
            process = subprocess.run(args, cwd=cwd, shell=False, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if check and process.returncode:
        raise RuntimeError((process.stderr or process.stdout or f"command failed: {cmd}").strip())
    return process


def clean_output(value):
    return (value or "").replace("\x00", "").strip()


def command_exists(name):
    return shutil.which(name) is not None


def should_exclude(rel, patterns):
    rel = str(rel).replace("\\", "/")
    parts = Path(rel).parts
    for pattern in patterns:
        if pattern in parts or fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(Path(rel).name, pattern):
            return True
    return False


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def is_linklike(path):
    try:
        if path.is_symlink():
            return True
        isjunction = getattr(os.path, "isjunction", None)
        return bool(isjunction and isjunction(path))
    except OSError:
        return True


def iter_files(root, excludes=None):
    root = Path(root)
    excludes = excludes or []
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        kept_dirs = []
        for dirname in dirs:
            candidate = current_path / dirname
            rel = candidate.relative_to(root).as_posix()
            if should_exclude(rel, excludes) or is_linklike(candidate):
                continue
            kept_dirs.append(dirname)
        dirs[:] = kept_dirs
        for filename in files:
            path = current_path / filename
            rel = path.relative_to(root).as_posix()
            if should_exclude(rel, excludes) or is_linklike(path):
                continue
            yield path, rel


def copy_tree_into_zip(zf, src, prefix, excludes):
    src = Path(src)
    files = 0
    total_bytes = 0
    for path, rel in iter_files(src, excludes):
        zf.write(path, f"{prefix}/{rel}")
        files += 1
        try:
            total_bytes += path.stat().st_size
        except OSError:
            pass
    return {"files": files, "bytes": total_bytes}


def git_info(path, patch_excludes=None):
    path = Path(path)
    patch_excludes = patch_excludes or []
    if not (path / ".git").exists():
        return None
    commit = clean_output(run(["git", "rev-parse", "HEAD"], cwd=path).stdout)
    remote = clean_output(run(["git", "remote", "get-url", "origin"], cwd=path, check=False).stdout)
    changed = run(["git", "diff", "--name-only", "HEAD", "--", "."], cwd=path, check=False).stdout.splitlines()
    included = [name for name in changed if not should_exclude(name, patch_excludes)]
    patch = run(["git", "diff", "--binary", "HEAD", "--", *included], cwd=path, check=False).stdout if included else ""
    untracked = run(["git", "ls-files", "--others", "--exclude-standard"], cwd=path, check=False).stdout.splitlines()
    branch = clean_output(run(["git", "branch", "--show-current"], cwd=path, check=False).stdout)
    return {"commit": commit, "remote": remote, "branch": branch, "patch": patch, "untracked": untracked}


def capture_system_inventory(manifest):
    variables = manifest["variables"]
    result = {
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "computer": platform.node(),
        "platform": platform.platform(),
        "python": sys.version,
        "logical_roots": {key: expand("{{" + key + "}}", variables) for key in variables},
        "commands": {},
    }
    version_args = {
        "git": ["git", "--version"],
        "node": ["node", "--version"],
        "corepack": ["corepack", "--version"],
        "python": [sys.executable, "--version"],
        "uv": ["uv", "--version"],
        "ffmpeg": ["ffmpeg", "-version"],
        "wsl": ["wsl.exe", "--version"],
        "ollama": ["ollama", "--version"],
    }
    for item in manifest.get("prerequisites", []):
        cid = item["id"]
        command = item["command"]
        resolved = shutil.which(command)
        entry = {"present": bool(resolved), "path": resolved}
        args = version_args.get(cid)
        if resolved and args:
            probe = run(args, check=False)
            value = clean_output(probe.stdout or probe.stderr)
            if value:
                entry["version"] = value.splitlines()[0]
        result["commands"][cid] = entry
    if command_exists("nvidia-smi"):
        probe = run([
            "nvidia-smi",
            "--query-gpu=name,memory.total,memory.used,driver_version",
            "--format=csv,noheader",
        ], check=False)
        result["gpu"] = clean_output(probe.stdout)
    if command_exists("wsl.exe"):
        probe = run(["wsl.exe", "-l", "-v"], check=False)
        result["wsl_distros"] = clean_output(probe.stdout or probe.stderr)
    if command_exists("npm"):
        probe = run(["npm", "list", "-g", "--depth=0"], check=False)
        result["npm_global"] = clean_output(probe.stdout or probe.stderr)
    if command_exists("ollama"):
        probe = run(["ollama", "list"], check=False)
        result["ollama_models"] = clean_output(probe.stdout or probe.stderr)
    return result


def inventory_tree(spec, variables):
    root = Path(expand(spec["path"], variables))
    include = spec.get("include", ["*"])
    do_hash = bool(spec.get("hash", False))
    record = {
        "id": spec["id"],
        "root": str(root),
        "present": root.exists(),
        "hash": do_hash,
        "files": [],
    }
    if not root.exists():
        return record
    for path, rel in iter_files(root):
        if include and not any(fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(path.name, pattern) for pattern in include):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        item = {"path": rel, "bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns}
        if do_hash:
            item["sha256"] = sha256_file(path)
        record["files"].append(item)
    record["total_bytes"] = sum(item["bytes"] for item in record["files"])
    record["file_count"] = len(record["files"])
    return record


def capture_wsl_inventories(manifest):
    records = []
    if not command_exists("wsl.exe"):
        return records
    for spec in manifest.get("wsl_inventories", []):
        distro = spec.get("distro")
        command = spec["command"]
        args = ["wsl.exe"]
        if distro:
            args += ["-d", distro]
        args += ["--", "bash", "-lc", command]
        probe = run(args, check=False)
        records.append({
            "id": spec["id"],
            "distro": distro,
            "command": command,
            "returncode": probe.returncode,
            "output": clean_output(probe.stdout or probe.stderr),
        })
    return records


def secret_status(manifest):
    variables = manifest["variables"]
    items = []
    for spec in manifest.get("secret_requirements", []):
        raw_path = spec.get("path", "")
        item = {"id": spec["id"], "path": raw_path, "restore": spec.get("restore", "manual")}
        if raw_path.startswith("WSL:") or raw_path.lower().startswith("windows credential"):
            item["present"] = None
        else:
            resolved = Path(expand(raw_path, variables))
            item["path"] = str(resolved)
            item["present"] = resolved.exists()
        items.append(item)
    return items


def apply_git_patch_idempotent(target, patch, component_id):
    target = Path(target)
    apply_check = run(["git", "apply", "--check", "--binary", str(patch)], cwd=target, check=False)
    if apply_check.returncode == 0:
        run(["git", "apply", "--binary", str(patch)], cwd=target)
        return "applied"
    reverse_check = run(["git", "apply", "--reverse", "--check", "--binary", str(patch)], cwd=target, check=False)
    if reverse_check.returncode == 0:
        return "already-applied"
    detail = clean_output(apply_check.stderr or apply_check.stdout)
    raise RuntimeError(
        f"cannot apply recovery patch for {component_id}; target has incompatible local changes"
        + (f": {detail}" if detail else "")
    )


def write_registry(manifest):
    variables = manifest["variables"]
    services = []
    for service in manifest.get("services", []):
        item = dict(service)
        for key, value in list(item.items()):
            if isinstance(value, str):
                item[key] = expand(value, variables)
        services.append(item)
    target = Path(expand("{{SNARK_REGISTRY_PATH}}", variables))
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "services": services,
    }
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def probe_tcp(host, port, timeout=0.8):
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True, None
    except OSError as error:
        return False, str(error)


def probe_http(url, timeout=1.5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 500, f"HTTP {response.status}"
    except Exception as error:
        return False, str(error)


def doctor(args):
    manifest = load_manifest()
    variables = manifest["variables"]
    bad = 0
    print("SnarkDeploy doctor")
    print("=" * 56)
    print("\nPrerequisites")
    for item in manifest.get("prerequisites", []):
        names = [item["command"]] + item.get("alternatives", [])
        ok = any(command_exists(name) for name in names)
        required = item.get("required", False)
        print(f"  {'OK ' if ok else ('ERR' if required else '---')} {item['id']}")
        if required and not ok:
            bad += 1
    print("\nComponents")
    for component in manifest.get("components", []):
        path = Path(expand(component["path"], variables))
        ok = path.exists()
        print(f"  {'OK ' if ok else '---'} {component['id']}: {path}")
        if component["id"] == "snarkroute" and not ok:
            bad += 1
    print("\nServices")
    for service in manifest.get("services", []):
        probe = service.get("probe", {})
        ok = False
        detail = ""
        if probe.get("type") == "tcp":
            ok, detail = probe_tcp(probe["host"], probe["port"])
        elif probe.get("type") == "http":
            base = service.get("endpoint", "").rstrip("/")
            ok, detail = probe_http(base + probe.get("path", ""))
        print(f"  {'UP ' if ok else 'down'} {service['id']}: {service.get('endpoint', '')} {detail or ''}".rstrip())
    print("\nSecret material")
    for item in secret_status(manifest):
        if item["present"] is True:
            state = "present (not exported)"
        elif item["present"] is False:
            state = "missing"
        else:
            state = item["restore"]
        print(f"  {item['id']}: {state}")
    if command_exists("nvidia-smi"):
        probe = run([
            "nvidia-smi",
            "--query-gpu=name,memory.total,memory.used,driver_version",
            "--format=csv,noheader",
        ], check=False)
        if probe.stdout.strip():
            print("\nGPU")
            for line in probe.stdout.strip().splitlines():
                print(" ", line)
    registry = write_registry(manifest)
    print(f"\nRegistry: {registry}")
    return bad


def snapshot(args):
    manifest = load_manifest()
    variables = manifest["variables"]
    excludes = manifest.get("snapshot_excludes", [])
    output = Path(args.output or ".").expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    destination = output / f"snark-recovery-{stamp}.zip"
    print("[snapshot] system inventory", flush=True)
    system = capture_system_inventory(manifest)
    heavy = []
    for spec in manifest.get("heavy_inventories", []):
        print(f"[snapshot] model inventory: {spec['id']}", flush=True)
        heavy.append(inventory_tree(spec, variables))
    print("[snapshot] WSL inventory", flush=True)
    wsl = capture_wsl_inventories(manifest)
    secrets = secret_status(manifest)
    state = {
        "schema_version": 2,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "bundle_name": destination.name,
        "components": [],
        "inventories": [],
        "secret_requirements": secrets,
    }
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as zf:
        for component in manifest.get("components", []):
            if not component.get("snapshot", False):
                continue
            print(f"[snapshot] component: {component['id']}", flush=True)
            path = Path(expand(component["path"], variables))
            record = {
                "id": component["id"],
                "path": str(path),
                "strategy": component["strategy"],
                "present": path.exists(),
            }
            if not path.exists():
                state["components"].append(record)
                continue
            component_excludes = excludes + component.get("snapshot_excludes", [])
            info = git_info(path, component.get("patch_excludes", [])) if component["strategy"] in ("git", "git-or-copy") else None
            if info and info.get("remote"):
                record.update({
                    "mode": "git",
                    "commit": info["commit"],
                    "remote": info["remote"],
                    "branch": info["branch"],
                })
                if info["patch"]:
                    zf.writestr(f"git/{component['id']}/working.patch", info["patch"])
                copied = 0
                copied_bytes = 0
                for rel in info["untracked"]:
                    source = path / rel
                    if source.is_file() and not should_exclude(rel, component_excludes):
                        zf.write(source, f"git/{component['id']}/untracked/{Path(rel).as_posix()}")
                        copied += 1
                        try:
                            copied_bytes += source.stat().st_size
                        except OSError:
                            pass
                record["untracked_files"] = copied
                record["untracked_bytes"] = copied_bytes
            else:
                record["mode"] = "copy"
                record["copy_stats"] = copy_tree_into_zip(zf, path, f"files/{component['id']}", component_excludes)
            state["components"].append(record)
        for inventory in manifest.get("inventories", []):
            path = Path(expand(inventory, variables))
            if path.is_file():
                key = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:12]
                member = f"inventories/{key}-{path.name}"
                zf.write(path, member)
                state["inventories"].append({
                    "source": str(path),
                    "file": member,
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                })
        zf.writestr("state.json", json.dumps(state, ensure_ascii=False, indent=2))
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr("system.json", json.dumps(system, ensure_ascii=False, indent=2))
        zf.writestr("heavy-inventory.json", json.dumps(heavy, ensure_ascii=False, indent=2))
        zf.writestr("wsl-inventory.json", json.dumps(wsl, ensure_ascii=False, indent=2))
        zf.writestr(
            "RESTORE.txt",
            "SnarkDeploy recovery bundle\n"
            "1. Clone/download SnarkRoute.\n"
            "2. Run deploy\\snarkdeploy\\bootstrap.ps1 -Bundle <this zip>.\n"
            "3. Re-enter secrets reported by snarkdeploy doctor.\n"
            "4. Large model weights are listed in heavy-inventory.json and model manifests; they are not duplicated here.\n",
        )
    digest = sha256_file(destination)
    sidecar = destination.with_suffix(destination.suffix + ".sha256")
    sidecar.write_text(f"{digest}  {destination.name}\n", encoding="ascii")
    print(f"Bundle: {destination}")
    print(f"SHA256: {digest}")
    print(f"Sidecar: {sidecar}")
    return 0


def scan_bundle_for_secrets(zf):
    path_hits = []
    value_hits = []
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if any(pattern.search(name) for pattern in FORBIDDEN_BUNDLE_PATHS):
            path_hits.append(name)
        if info.file_size <= 0 or info.file_size > SECRET_SCAN_LIMIT:
            continue
        if Path(name).suffix.lower() not in TEXT_EXTENSIONS:
            continue
        try:
            data = zf.read(info)
        except Exception:
            continue
        if any(pattern.search(data) for pattern in HIGH_CONFIDENCE_SECRET_PATTERNS):
            value_hits.append(name)
            continue
        lowered = name.lower()
        if "/data/" in lowered or "/config/" in lowered:
            match = LITERAL_SECRET_ASSIGNMENT.search(data)
            if match:
                value = match.group(1).lower()
                if not value.startswith((b"process.", b"os.", b"env.", b"self.", b"config.")):
                    value_hits.append(name)
    return sorted(set(path_hits)), sorted(set(value_hits))


def verify_bundle(bundle, quiet=False):
    bundle = Path(bundle).expanduser().resolve()
    if not bundle.is_file():
        raise FileNotFoundError(bundle)
    sidecar = bundle.with_suffix(bundle.suffix + ".sha256")
    expected = None
    if sidecar.is_file():
        expected = sidecar.read_text(encoding="ascii", errors="ignore").strip().split()[0].lower()
        actual = sha256_file(bundle)
        if expected != actual.lower():
            raise RuntimeError(f"SHA256 mismatch: expected {expected}, got {actual}")
    with zipfile.ZipFile(bundle, "r") as zf:
        bad_member = zf.testzip()
        if bad_member:
            raise RuntimeError(f"ZIP CRC failure: {bad_member}")
        names = zf.namelist()
        for required in ("state.json", "manifest.json", "system.json", "heavy-inventory.json"):
            if required not in names:
                raise RuntimeError(f"bundle is missing {required}")
        forbidden = {".env", ".env.local", ".env.production", "credentials.json", "secrets.json", "worker-token"}
        leaked = []
        for name in names:
            if Path(name).name.lower() in forbidden:
                leaked.append(name)
        if leaked:
            raise RuntimeError("bundle contains forbidden secret material: " + ", ".join(leaked[:5]))
        forbidden_paths, secret_values = scan_bundle_for_secrets(zf)
        if forbidden_paths or secret_values:
            affected = (forbidden_paths + secret_values)[:5]
            raise RuntimeError("bundle security scan failed: " + ", ".join(affected))
        state = json.loads(zf.read("state.json").decode("utf-8"))
    if not quiet:
        present = sum(1 for item in state.get("components", []) if item.get("present"))
        print(f"Bundle OK: {bundle}")
        print(f"Components present: {present}/{len(state.get('components', []))}")
        print(f"SHA256 sidecar: {'OK' if expected else 'not present'}")
    return state


def restore(args):
    bundle = Path(args.bundle).expanduser().resolve()
    state = verify_bundle(bundle, quiet=True)
    current = load_manifest()
    variables = current["variables"]
    if args.dry_run:
        print("SnarkDeploy restore dry-run")
        for record in state.get("components", []):
            component = next((item for item in current["components"] if item["id"] == record["id"]), None)
            if not component:
                print(f"  skip unknown component: {record['id']}")
                continue
            target = Path(expand(component["path"], variables))
            print(f"  {record['id']}: {record.get('mode', 'missing')} -> {target}")
        return 0
    with zipfile.ZipFile(bundle, "r") as zf:
        for record in state.get("components", []):
            if not record.get("present"):
                continue
            component = next((item for item in current["components"] if item["id"] == record["id"]), None)
            if not component:
                continue
            target = Path(expand(component["path"], variables))
            target.parent.mkdir(parents=True, exist_ok=True)
            if record.get("mode") == "git":
                if not (target / ".git").exists():
                    if target.exists() and any(target.iterdir()):
                        raise RuntimeError(f"restore target is non-empty: {target}")
                    target.mkdir(parents=True, exist_ok=True)
                    run(["git", "init"], cwd=target)
                    run(["git", "remote", "add", "origin", record["remote"]], cwd=target)
                elif clean_output(run(["git", "remote", "get-url", "origin"], cwd=target, check=False).stdout) != record["remote"]:
                    run(["git", "remote", "set-url", "origin", record["remote"]], cwd=target)
                has_commit = run(
                    ["git", "cat-file", "-e", f"{record['commit']}^{{commit}}"],
                    cwd=target,
                    check=False,
                ).returncode == 0
                if not has_commit:
                    fetch = run(["git", "fetch", "--depth=1", "origin", record["commit"]], cwd=target, check=False)
                    if fetch.returncode:
                        run(["git", "fetch", "origin", record["commit"]], cwd=target)
                run(["git", "checkout", "--detach", record["commit"]], cwd=target)
                patch_name = f"git/{record['id']}/working.patch"
                if patch_name in zf.namelist():
                    with tempfile.NamedTemporaryFile("wb", delete=False, suffix=".patch") as temp:
                        temp.write(zf.read(patch_name))
                        patch = temp.name
                    try:
                        apply_git_patch_idempotent(target, patch, record["id"])
                    finally:
                        os.unlink(patch)
                prefix = f"git/{record['id']}/untracked/"
                for name in zf.namelist():
                    if name.startswith(prefix) and not name.endswith("/"):
                        rel = name[len(prefix):]
                        destination = target / Path(rel)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with zf.open(name) as source, open(destination, "wb") as output:
                            shutil.copyfileobj(source, output)
            else:
                prefix = f"files/{record['id']}/"
                target.mkdir(parents=True, exist_ok=True)
                for name in zf.namelist():
                    if name.startswith(prefix) and not name.endswith("/"):
                        rel = name[len(prefix):]
                        destination = target / Path(rel)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with zf.open(name) as source, open(destination, "wb") as output:
                            shutil.copyfileobj(source, output)
    registry = write_registry(current)
    print(f"Restore complete. Registry: {registry}")
    return 0


def install(args):
    manifest = load_manifest()
    variables = manifest["variables"]
    if command_exists("npm"):
        for package in manifest.get("global_npm_packages", []):
            bare = package.rsplit("@", 1)[0] if package.startswith("@") else package.split("@", 1)[0]
            check = run(["npm", "list", "-g", bare, "--depth=0"], check=False)
            if check.returncode:
                print(f"[global npm] installing {package}")
                run(["npm", "install", "-g", package])
    for component in manifest.get("components", []):
        path = Path(expand(component["path"], variables))
        if component.get("remote") and not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            print(f"Cloning {component['id']} -> {path}")
            run(["git", "clone", component["remote"], str(path)])
        for command in component.get("install_commands", []):
            if path.exists():
                print(f"[{component['id']}] {command}")
                run(command, cwd=path)
    registry = write_registry(manifest)
    print(f"Install complete. Registry: {registry}")
    return 0


def main():
    parser = argparse.ArgumentParser(prog="snarkdeploy")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    snapshot_parser = sub.add_parser("snapshot")
    snapshot_parser.add_argument("--output", default=".")
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("bundle")
    restore_parser = sub.add_parser("restore")
    restore_parser.add_argument("bundle")
    restore_parser.add_argument("--dry-run", action="store_true")
    sub.add_parser("install")
    args = parser.parse_args()
    try:
        if args.command == "doctor":
            code = doctor(args)
        elif args.command == "snapshot":
            code = snapshot(args)
        elif args.command == "verify":
            verify_bundle(args.bundle)
            code = 0
        elif args.command == "restore":
            code = restore(args)
        else:
            code = install(args)
        raise SystemExit(code)
    except KeyboardInterrupt:
        raise
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
