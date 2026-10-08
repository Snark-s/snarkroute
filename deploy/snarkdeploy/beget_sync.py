#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

DEFAULT_REMOTE_DIR = "snark-backups-rclone"
DEFAULT_KEEP = 5
HOST = "plotva.beget.com"
USER = "sirano"
HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKcEECcmmjfdI9Poq4zTdCwArHCY/txB/dg/SdkAGncJ"


def latest_file(source: Path, pattern: str) -> Path:
    items = sorted(source.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    if not items:
        raise FileNotFoundError(f"No files matching {pattern} in {source}")
    return items[0]


def ensure_sha256(path: Path) -> Path:
    sidecar = path.with_suffix(path.suffix + ".sha256")
    if sidecar.is_file():
        text = sidecar.read_text(encoding="ascii", errors="ignore").strip()
        parts = text.split()
        if len(parts) >= 2 and parts[1] == path.name and len(parts[0]) == 64:
            return sidecar

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    sidecar.write_text(f"{digest.hexdigest()}  {path.name}\n", encoding="ascii")
    return sidecar


def find_rclone(source: Path) -> Path:
    candidates = []
    tools = source / "SnarkDeploy"
    if tools.exists():
        candidates.extend(tools.rglob("rclone.exe"))
    found = shutil.which("rclone")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "rclone.exe not found. Expected a portable copy under SnarkBackups\\SnarkDeploy\\Rclone."
    )


def find_key() -> Path:
    candidate = Path.home() / ".ssh" / "personacore_beget_ed25519"
    if candidate.is_file():
        return candidate
    raise FileNotFoundError(
        f"Beget SSH key not found: {candidate}. Restore the encrypted secrets archive first."
    )


def make_config(path: Path, key: Path, remote_dir: str) -> None:
    content = (
        "[beget_raw]\n"
        "type = sftp\n"
        f"host = {HOST}\n"
        f"user = {USER}\n"
        f"key_file = {key}\n"
        f"host_keys = {HOST_KEY}\n"
        "disable_hashcheck = true\n"
        "shell_type = none\n"
        "concurrency = 8\n"
        "chunk_size = 255Ki\n"
        "idle_timeout = 15s\n"
        "\n"
        "[beget]\n"
        "type = chunker\n"
        f"remote = beget_raw:{remote_dir}\n"
        "chunk_size = 16Mi\n"
        "hash_type = md5\n"
        "meta_format = simplejson\n"
        "fail_hard = true\n"
        "transactions = rename\n"
    )
    path.write_text(content, encoding="utf-8")


def run_rclone(
    exe: Path,
    config: Path,
    args: list[str],
    *,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess:
    command = [
        str(exe),
        *args,
        "--config",
        str(config),
        "--transfers",
        "1",
        "--checkers",
        "1",
        "--retries",
        "8",
        "--low-level-retries",
        "20",
        "--contimeout",
        "15s",
        "--timeout",
        "60s",
    ]
    result = subprocess.run(
        command,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture,
    )
    if check and result.returncode:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(detail or f"rclone failed with exit code {result.returncode}")
    return result


def copy_file(exe: Path, config: Path, local: Path, remote_path: str) -> None:
    print(f"Uploading {local.name} -> Beget:{remote_path}", flush=True)
    run_rclone(
        exe,
        config,
        ["copyto", str(local), f"beget:{remote_path}", "--stats", "10s", "--stats-one-line"],
    )


def remote_names(exe: Path, config: Path) -> list[str]:
    result = run_rclone(
        exe,
        config,
        ["lsf", "beget:", "--files-only"],
        capture=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def generation_key(name: str, prefix: str) -> str | None:
    match = re.match(rf"^{re.escape(prefix)}-(\d{{8}}-\d{{6}})\.zip$", name)
    return match.group(1) if match else None


def prune(exe: Path, config: Path, prefix: str, keep: int) -> list[str]:
    generations = []
    for name in remote_names(exe, config):
        key = generation_key(name, prefix)
        if key:
            generations.append((key, name))
    generations.sort(reverse=True)

    removed: list[str] = []
    for _, name in generations[keep:]:
        for victim in (name, name + ".sha256"):
            result = run_rclone(
                exe,
                config,
                ["deletefile", f"beget:{victim}"],
                capture=True,
                check=False,
            )
            if result.returncode == 0:
                removed.append(victim)
    return removed


def verify_remote(exe: Path, config: Path, local: Path, remote_name: str) -> None:
    result = run_rclone(
        exe,
        config,
        ["lsjson", "beget:", "--files-only", "--include", f"/{remote_name}", "--hash"],
        capture=True,
        check=False,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"Remote verification failed for {remote_name}: {detail}")

    try:
        items = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid remote metadata for {remote_name}") from exc

    item = next((entry for entry in items if entry.get("Path") == remote_name), None)
    if item is None:
        raise RuntimeError(f"Remote file missing after upload: {remote_name}")

    local_size = local.stat().st_size
    remote_size = int(item.get("Size", -1))
    if remote_size != local_size:
        raise RuntimeError(
            f"Remote size mismatch for {remote_name}: local={local_size}, remote={remote_size}"
        )

    hashes = item.get("Hashes") or {}
    remote_md5 = hashes.get("MD5") or hashes.get("md5")
    if remote_md5:
        md5 = hashlib.md5()
        with local.open("rb") as handle:
            for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                md5.update(chunk)
        local_md5 = md5.hexdigest()
        if local_md5.lower() != remote_md5.lower():
            raise RuntimeError(
                f"Remote MD5 mismatch for {remote_name}: local={local_md5}, remote={remote_md5}"
            )
        print(f"Verified on Beget: {remote_name} (size + MD5)", flush=True)
    else:
        print(f"Verified on Beget: {remote_name} (size)", flush=True)


def cleanup_orphan_chunks(exe: Path, config: Path, remote_dir: str) -> list[str]:
    result = run_rclone(
        exe,
        config,
        ["lsf", f"beget_raw:{remote_dir}", "--files-only", "--recursive"],
        capture=True,
    )
    pattern = re.compile(r"\.rclone_chunk\.\d+_[A-Za-z0-9]+$")
    orphaned = [
        name
        for name in (line.strip() for line in result.stdout.splitlines())
        if name and pattern.search(name)
    ]
    if not orphaned:
        return []

    deleted = run_rclone(
        exe,
        config,
        [
            "delete",
            f"beget_raw:{remote_dir}",
            "--include",
            "*.rclone_chunk.*_*",
            "--include",
            "**/*.rclone_chunk.*_*",
        ],
        capture=True,
        check=False,
    )
    if deleted.returncode != 0:
        detail = (deleted.stderr or deleted.stdout or "").strip()
        raise RuntimeError(f"Failed to clean orphan chunks: {detail}")
    return orphaned


def sync(source: Path, remote_dir: str, keep: int) -> None:
    source = source.resolve()
    exe = find_rclone(source)
    key = find_key()

    recovery = latest_file(source, "snark-recovery-*.zip")
    recovery_sha = ensure_sha256(recovery)
    secrets = latest_file(source, "snark-secrets-*.zip")
    secrets_sha = ensure_sha256(secrets)

    with tempfile.TemporaryDirectory(prefix="snark-rclone-") as td:
        config = Path(td) / "rclone.conf"
        make_config(config, key, remote_dir)

        print(f"Beget remote: {USER}@{HOST}:{remote_dir}", flush=True)
        print(f"rclone: {exe}", flush=True)

        copy_file(exe, config, recovery, recovery.name)
        copy_file(exe, config, recovery_sha, recovery_sha.name)
        copy_file(exe, config, secrets, secrets.name)
        copy_file(exe, config, secrets_sha, secrets_sha.name)

        for name in ("START_HERE.txt", "LATEST.txt"):
            local = source / name
            if local.is_file():
                copy_file(exe, config, local, name)

        tools = source / "SnarkDeploy"
        for name in (
            "bootstrap.ps1",
            "snarkdeploy.py",
            "manifest.json",
            "secrets_archive.py",
            "beget_sync.py",
            "SNARK_BACKUP.cmd",
            "SNARK_RESTORE.cmd",
            "rclone.zip",
        ):
            local = tools / name
            if local.is_file():
                copy_file(exe, config, local, f"SnarkDeploy/{name}")

        verify_remote(exe, config, recovery, recovery.name)
        verify_remote(exe, config, secrets, secrets.name)

        removed = []
        removed.extend(prune(exe, config, "snark-recovery", keep))
        removed.extend(prune(exe, config, "snark-secrets", keep))
        orphaned = cleanup_orphan_chunks(exe, config, remote_dir)

        remote_latest = (
            "SNARK REMOTE BACKUP\n"
            f"Latest recovery: {recovery.name}\n"
            f"Latest secrets: {secrets.name}\n"
            f"Retention: last {keep} recovery generations and last {keep} secrets generations\n"
            f"Storage backend: rclone chunker over SFTP, 16 MiB physical chunks\n"
        )
        index = Path(td) / "REMOTE_LATEST.txt"
        index.write_text(remote_latest, encoding="utf-8")
        copy_file(exe, config, index, "REMOTE_LATEST.txt")

        print("Beget upload complete.", flush=True)
        if removed:
            print("Pruned remote files: " + ", ".join(removed), flush=True)
        if orphaned:
            print(f"Cleaned orphan chunk files: {len(orphaned)}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--remote-dir", default=DEFAULT_REMOTE_DIR)
    parser.add_argument("--keep", type=int, default=DEFAULT_KEEP)
    args = parser.parse_args()

    if args.keep < 1:
        raise SystemExit("--keep must be >= 1")

    sync(args.source, args.remote_dir, args.keep)


if __name__ == "__main__":
    main()
