#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
import posixpath
import re
import shutil
from pathlib import Path

DEFAULT_ALIAS = "beget-wp"
DEFAULT_REMOTE_DIR = "snark-backups"
DEFAULT_KEEP = 5
CHUNK = 4 * 1024 * 1024


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def parse_ssh_config(alias: str) -> dict:
    config_path = Path.home() / ".ssh" / "config"
    if not config_path.is_file():
        raise FileNotFoundError(f"SSH config not found: {config_path}")
    try:
        import paramiko
    except ImportError as exc:
        raise RuntimeError("paramiko is required; run via uv with paramiko.") from exc
    config = paramiko.SSHConfig()
    with config_path.open("r", encoding="utf-8", errors="replace") as f:
        config.parse(f)
    entry = config.lookup(alias)
    host = entry.get("hostname", alias)
    user = entry.get("user") or os.getenv("USERNAME")
    identity = entry.get("identityfile", [])
    if isinstance(identity, str):
        identity = [identity]
    key = None
    for candidate in identity:
        candidate = os.path.expandvars(os.path.expanduser(candidate))
        p = Path(candidate)
        if p.is_file():
            key = p
            break
    if key is None:
        raise FileNotFoundError(f"No usable IdentityFile found for SSH alias {alias}")
    return {"host": host, "user": user, "key": key}


def connect(alias: str):
    import paramiko
    cfg = parse_ssh_config(alias)
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=cfg["host"],
        username=cfg["user"],
        key_filename=str(cfg["key"]),
        timeout=15,
        auth_timeout=15,
        banner_timeout=15,
        look_for_keys=False,
        allow_agent=False,
    )
    return client, cfg


def ensure_remote_dir(sftp, path: str) -> None:
    current = ""
    for piece in path.strip("/").split("/"):
        if not piece:
            continue
        current = posixpath.join(current, piece)
        try:
            sftp.stat(current)
        except OSError:
            sftp.mkdir(current)


def latest_file(source: Path, pattern: str) -> Path:
    items = sorted(source.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    if not items:
        raise FileNotFoundError(f"No files matching {pattern} in {source}")
    return items[0]


def ensure_sidecar(path: Path) -> Path:
    sidecar = path.with_suffix(path.suffix + ".sha256")
    if sidecar.is_file():
        text = sidecar.read_text(encoding="ascii", errors="ignore").strip()
        parts = text.split()
        if len(parts) >= 2 and parts[1] == path.name and len(parts[0]) == 64:
            return sidecar
    digest = sha256_file(path)
    sidecar.write_text(f"{digest}  {path.name}\n", encoding="ascii")
    return sidecar


def upload_atomic(sftp, local: Path, remote_dir: str) -> None:
    remote = posixpath.join(remote_dir, local.name)
    partial = remote + ".partial"
    sftp.put(str(local), partial)
    local_size = local.stat().st_size
    remote_size = sftp.stat(partial).st_size
    if local_size != remote_size:
        try:
            sftp.remove(partial)
        except OSError:
            pass
        raise RuntimeError(f"Size mismatch uploading {local.name}: local={local_size}, remote={remote_size}")
    try:
        sftp.remove(remote)
    except OSError:
        pass
    sftp.rename(partial, remote)


def list_remote(sftp, remote_dir: str):
    try:
        return sftp.listdir_attr(remote_dir)
    except OSError:
        return []


def generation_key(name: str, prefix: str) -> str | None:
    match = re.match(rf"^{re.escape(prefix)}-(\d{{8}}-\d{{6}})\.zip$", name)
    return match.group(1) if match else None


def prune_generations(sftp, remote_dir: str, prefix: str, keep: int) -> list[str]:
    attrs = list_remote(sftp, remote_dir)
    generations = []
    for attr in attrs:
        key = generation_key(attr.filename, prefix)
        if key:
            generations.append((key, attr.filename))
    generations.sort(reverse=True)
    removed = []
    for _, filename in generations[keep:]:
        base = posixpath.join(remote_dir, filename)
        for remote in (base, base + ".sha256"):
            try:
                sftp.remove(remote)
                removed.append(posixpath.basename(remote))
            except OSError:
                pass
    return removed


def remote_sha256(client, remote_path: str) -> str | None:
    escaped = remote_path.replace("'", "'\\''")
    _, stdout, _ = client.exec_command(f"sha256sum '{escaped}'", timeout=30)
    output = stdout.read().decode("utf-8", "replace").strip()
    if not output:
        return None
    return output.split()[0].lower()


def sync(source: Path, alias: str, remote_dir: str, keep: int) -> None:
    source = source.resolve()
    recovery = latest_file(source, "snark-recovery-*.zip")
    recovery_sha = ensure_sidecar(recovery)
    secrets = latest_file(source, "snark-secrets-*.zip")
    secrets_sha = ensure_sidecar(secrets)

    client, cfg = connect(alias)
    try:
        sftp = client.open_sftp()
        ensure_remote_dir(sftp, remote_dir)
        tools_remote = posixpath.join(remote_dir, "SnarkDeploy")
        ensure_remote_dir(sftp, tools_remote)

        print(f"Beget: {cfg['user']}@{cfg['host']}:{remote_dir}")
        for local in (recovery, recovery_sha, secrets, secrets_sha):
            print(f"Uploading {local.name} ...")
            upload_atomic(sftp, local, remote_dir)

        for name in ("START_HERE.txt", "LATEST.txt"):
            local = source / name
            if local.is_file():
                upload_atomic(sftp, local, remote_dir)

        tools = source / "SnarkDeploy"
        for name in (
            "bootstrap.ps1", "snarkdeploy.py", "manifest.json", "secrets_archive.py",
            "beget_sync.py", "SNARK_BACKUP.cmd", "SNARK_RESTORE.cmd",
        ):
            local = tools / name
            if local.is_file():
                upload_atomic(sftp, local, tools_remote)

        remote_recovery = posixpath.join(remote_dir, recovery.name)
        remote_digest = remote_sha256(client, remote_recovery)
        local_digest = recovery_sha.read_text(encoding="ascii").split()[0].lower()
        if remote_digest and remote_digest != local_digest:
            raise RuntimeError(
                f"Remote recovery checksum mismatch: local={local_digest}, remote={remote_digest}"
            )

        removed = []
        removed += prune_generations(sftp, remote_dir, "snark-recovery", keep)
        removed += prune_generations(sftp, remote_dir, "snark-secrets", keep)

        import tempfile
        with tempfile.TemporaryDirectory() as td:
            index_file = Path(td) / "REMOTE_LATEST.txt"
            index_file.write_text(
                "SNARK REMOTE BACKUP\n"
                f"Latest recovery: {recovery.name}\n"
                f"Recovery SHA256: {local_digest}\n"
                f"Latest secrets: {secrets.name}\n"
                f"Retention: last {keep} recovery generations and last {keep} secrets generations\n",
                encoding="utf-8",
            )
            upload_atomic(sftp, index_file, remote_dir)

        print("Beget upload complete.")
        if removed:
            print("Pruned remote files: " + ", ".join(removed))
    finally:
        try:
            client.close()
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--alias", default=DEFAULT_ALIAS)
    parser.add_argument("--remote-dir", default=DEFAULT_REMOTE_DIR)
    parser.add_argument("--keep", type=int, default=DEFAULT_KEEP)
    args = parser.parse_args()
    if args.keep < 1:
        raise SystemExit("--keep must be >= 1")
    sync(args.source, args.alias, args.remote_dir, args.keep)


if __name__ == "__main__":
    main()
