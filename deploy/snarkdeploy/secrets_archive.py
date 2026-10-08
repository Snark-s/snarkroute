#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

try:
    import winreg
except ImportError:
    winreg = None

DEFAULT_OUTPUT = Path(r"X:\SnarkBackups")
DEFAULT_KEY = Path(r"I:\SnarkRecoveryKey\SNARK_RECOVERY_PASSWORD.txt")
SEVEN_ZIP_CANDIDATES = [
    Path(r"C:\Program Files\7-Zip\7z.exe"),
    Path(r"C:\Program Files (x86)\7-Zip\7z.exe"),
]

EXCLUDED_PARTS = {".git", "node_modules", ".venv", "__pycache__", "dist", "build"}


def seven_zip() -> Path:
    for candidate in SEVEN_ZIP_CANDIDATES:
        if candidate.is_file():
            return candidate
    found = shutil.which("7z") or shutil.which("7za")
    if found:
        return Path(found)
    raise RuntimeError("7-Zip is required. Install winget package 7zip.7zip.")


def ensure_password(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        value = path.read_text(encoding="utf-8").strip()
        if len(value) < 24:
            raise RuntimeError(f"Password file is unexpectedly short: {path}")
        return value
    value = secrets.token_urlsafe(36)
    path.write_text(value + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    readme = path.parent / "README.txt"
    readme.write_text(
        "This password unlocks Snark encrypted recovery-secret ZIP files stored on the other backup disk.\n"
        "Keep this disk physically separate from the recovery archive disk.\n",
        encoding="utf-8",
    )
    return value


def should_skip(path: Path, root: Path) -> bool:
    try:
        rel = path.relative_to(root)
    except ValueError:
        return True
    return any(part in EXCLUDED_PARTS for part in rel.parts)


def iter_env_files(root: Path):
    for current, dirs, names in os.walk(root):
        dirs[:] = [name for name in dirs if name not in EXCLUDED_PARTS]
        base = Path(current)
        for name in names:
            lowered = name.lower()
            if lowered.startswith(".env") and not lowered.endswith(".example"):
                yield base / name


def discover_windows_secrets() -> list[Path]:
    files: list[Path] = []

    snark = Path(r"Y:\Процесс\SnarkRoute")
    if snark.exists():
        files.extend(iter_env_files(snark))

    ssh_dir = Path.home() / ".ssh"
    if ssh_dir.exists():
        for name in ("config", "personacore_beget_ed25519", "personacore_beget_ed25519.pub"):
            candidate = ssh_dir / name
            if candidate.is_file():
                files.append(candidate)

    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        candidate = Path(f"{letter}:\\SnarkRecoveryKey\\BEGET_UPLOAD_TOKEN.txt")
        if candidate.is_file():
            files.append(candidate)
            break

    persona = Path(r"I:\PersonaCore")
    if persona.exists():
        config = persona / "config"
        if config.exists():
            files.extend(p for p in config.glob("secrets.*") if p.is_file())
        harness = persona / "data" / "runtime" / "harness"
        if harness.exists():
            files.extend(p for p in harness.glob("*credentials*") if p.is_file())
        files.extend(iter_env_files(persona))

    unique: list[Path] = []
    seen = set()
    for path in files:
        key = str(path.resolve()).lower()
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def archive_name_for(path: Path) -> str:
    mappings = [
        (Path(r"Y:\Процесс\SnarkRoute"), "windows/snarkroute"),
        (Path(r"I:\PersonaCore"), "windows/personacore"),
        (Path.home(), "windows/userhome"),
    ]
    for root, prefix in mappings:
        try:
            rel = path.relative_to(root)
            return f"{prefix}/{rel.as_posix()}"
        except ValueError:
            pass
    return f"windows/other/{path.name}"


def read_wsl_file(linux_path: str, distro: str = "Ubuntu-24.04") -> bytes | None:
    shell_path = linux_path.replace("~/", "$HOME/", 1)
    script = f'test -f "{shell_path}" && cat "{shell_path}"'
    cmd = ["wsl.exe", "-d", distro, "--", "bash", "-lc", script]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0 or not result.stdout:
        return None
    return result.stdout


def collect_wsl_secrets() -> list[dict]:
    specs = [
        ("h3-worker-token", "~/h3/runtime/worker-token"),
        ("huggingface-cache-token", "~/.cache/huggingface/token"),
        ("huggingface-home-token", "~/.huggingface/token"),
    ]
    found = []
    for name, linux_path in specs:
        data = read_wsl_file(linux_path)
        if data:
            found.append({"id": name, "path": linux_path, "data": data})
    return found


def make_backup(output: Path, key_path: Path) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    password = ensure_password(key_path)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    archive = output / f"snark-secrets-{stamp}.zip"

    windows_files = discover_windows_secrets()
    wsl_files = collect_wsl_secrets()

    with tempfile.TemporaryDirectory(prefix="snark-secrets-") as temp_name:
        temp = Path(temp_name)
        payload_root = temp / "payload"
        payload_root.mkdir()

        manifest = {
            "schema_version": 1,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "windows": [],
            "wsl": [],
            "notes": [
                "FreeToken Desktop is restored as a local runtime; no external account requirement is recorded.",
                "The archive contains secrets. Do not store its password on the same physical disk.",
            ],
        }

        for source in windows_files:
            arcname = archive_name_for(source)
            target = payload_root / Path(arcname)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            manifest["windows"].append({"source": str(source), "payload": arcname})

        for item in wsl_files:
            arcname = f"wsl/{item['id']}"
            target = payload_root / arcname
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(item["data"])
            manifest["wsl"].append({
                "distro": "Ubuntu-24.04",
                "source": item["path"],
                "payload": arcname,
            })

        (payload_root / "SECRETS_MANIFEST.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        tar_path = temp / "snark-secrets.tar"
        with tarfile.open(tar_path, "w") as tar:
            for path in payload_root.rglob("*"):
                if path.is_file():
                    tar.add(path, arcname=path.relative_to(payload_root).as_posix())

        command = [
            str(seven_zip()), "a", "-tzip", str(archive), str(tar_path),
            f"-p{password}", "-mem=AES256", "-mx=9", "-y",
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout).strip())

    marker = output / "SECRETS_PASSWORD_LOCATION.txt"
    marker.write_text(
        f"Encrypted secret archives use AES-256.\nPassword file is on a different physical disk:\n{key_path}\n",
        encoding="utf-8",
    )
    digest = hashlib.sha256()
    with archive.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    sidecar = archive.with_suffix(archive.suffix + ".sha256")
    sidecar.write_text(f"{digest.hexdigest()}  {archive.name}\n", encoding="ascii")

    latest = output / "LATEST_SECRETS.txt"
    latest.write_text(f"{archive.name}\n", encoding="utf-8")
    print(f"Encrypted secrets archive: {archive}")
    print(f"Password location: {key_path}")
    print(f"Windows secret files: {len(windows_files)}")
    print(f"WSL secret files: {len(wsl_files)}")
    return archive


def extract_payload(archive: Path, password: str, temp: Path) -> Path:
    command = [
        str(seven_zip()), "x", str(archive), f"-p{password}",
        f"-o{temp}", "-y",
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError("Could not decrypt secret archive. Password may be wrong.")
    tar_path = temp / "snark-secrets.tar"
    if not tar_path.is_file():
        raise RuntimeError("Encrypted archive does not contain snark-secrets.tar")
    payload = temp / "payload"
    payload.mkdir()
    with tarfile.open(tar_path, "r") as tar:
        tar.extractall(payload, filter="data")
    return payload


def write_wsl_file(distro: str, linux_path: str, data: bytes) -> None:
    parent = linux_path.rsplit("/", 1)[0]
    script = f"mkdir -p {parent!r} && cat > {linux_path!r} && chmod 600 {linux_path!r}"
    result = subprocess.run(
        ["wsl.exe", "-d", distro, "--", "bash", "-lc", script],
        input=data,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to restore WSL secret: {linux_path}")


def user_env(name: str) -> str | None:
    value = os.getenv(name)
    if value:
        return value
    if winreg is None:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _ = winreg.QueryValueEx(key, name)
            return str(value) if value else None
    except OSError:
        return None


def resolve_restore_path(source_text: str) -> Path:
    source = Path(source_text)
    old_snark = Path(r"Y:\Процесс\SnarkRoute")
    old_persona = Path(r"I:\PersonaCore")

    process_root = Path(user_env("SNARK_PROCESS_ROOT") or (r"Y:\Процесс" if Path("Y:\\").exists() else r"C:\Snark\Process"))
    persona_home = Path(user_env("PERSONA_HOME") or (r"I:\PersonaCore" if Path("I:\\").exists() else r"C:\Snark\PersonaCore"))

    try:
        return process_root / "SnarkRoute" / source.relative_to(old_snark)
    except ValueError:
        pass
    try:
        return persona_home / source.relative_to(old_persona)
    except ValueError:
        pass
    if ".ssh" in source.parts:
        index = source.parts.index(".ssh")
        return Path.home().joinpath(*source.parts[index:])
    return source


def find_password_file(preferred: Path) -> Path | None:
    if preferred.is_file():
        return preferred
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        candidate = Path(f"{letter}:\\SnarkRecoveryKey\\SNARK_RECOVERY_PASSWORD.txt")
        if candidate.is_file():
            return candidate
    return None


def restore_backup(archive: Path, key_path: Path) -> None:
    located_key = find_password_file(key_path)
    if located_key:
        password = located_key.read_text(encoding="utf-8").strip()
    else:
        password = getpass.getpass("Recovery secrets password: ")

    with tempfile.TemporaryDirectory(prefix="snark-secrets-restore-") as temp_name:
        payload = extract_payload(archive, password, Path(temp_name))
        manifest = json.loads((payload / "SECRETS_MANIFEST.json").read_text(encoding="utf-8"))

        for item in manifest.get("windows", []):
            source_path = Path(item["source"])
            if source_path.name == "BEGET_UPLOAD_TOKEN.txt" and located_key:
                destination = located_key.parent / "BEGET_UPLOAD_TOKEN.txt"
            else:
                destination = resolve_restore_path(item["source"])
            stored = payload / item["payload"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(stored, destination)

        for item in manifest.get("wsl", []):
            stored = payload / item["payload"]
            write_wsl_file(item["distro"], item["source"], stored.read_bytes())

    print("Secret files restored.")


def newest_secret_archive(output: Path) -> Path:
    archives = sorted(output.glob("snark-secrets-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not archives:
        raise FileNotFoundError("No snark-secrets-*.zip found")
    return archives[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    backup = sub.add_parser("backup")
    backup.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    backup.add_argument("--key-file", type=Path, default=DEFAULT_KEY)

    restore = sub.add_parser("restore")
    restore.add_argument("archive", nargs="?", type=Path)
    restore.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    restore.add_argument("--key-file", type=Path, default=DEFAULT_KEY)

    args = parser.parse_args()
    if args.command == "backup":
        make_backup(args.output, args.key_file)
    else:
        archive = args.archive or newest_secret_archive(args.output)
        restore_backup(archive, args.key_file)


if __name__ == "__main__":
    main()
