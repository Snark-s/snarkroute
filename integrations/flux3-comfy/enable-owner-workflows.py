#!/usr/bin/env python3
"""ONE-TIME OWNER-LOCAL setup. Never run this through an MCP tool.
Installs three immutable, narrowly-scoped SnarkRoute/FLUX.3 workflows.
No arbitrary shell capability is granted.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(r"I:\SnarkBridge")
CONFIG = Path(os.environ.get("SNARKBRIDGE_CONFIG", str(ROOT / "bridge-config.json")))
SRC = Path(__file__).resolve().with_name("owner-flux3-workflow.ps1")
DST = ROOT / "owner-workflows" / "flux3-owner-workflow.ps1"

def atomic_write(path: Path, data: bytes) -> None:
    fd, name = tempfile.mkstemp(prefix="snarkbridge-owner-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def main() -> None:
    if not CONFIG.is_file() or not SRC.is_file():
        raise SystemExit(f"Owner policy or runner missing. Policy={CONFIG}; runner={SRC}")
    doc = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    if not isinstance(doc, dict) or not isinstance(doc.get("trusted_workflows"), dict):
        raise SystemExit("Unexpected SnarkBridge owner policy layout: missing trusted_workflows")
    clients = doc.get("clients")
    if not isinstance(clients, dict) or not isinstance(clients.get("chatgpt"), dict):
        raise SystemExit("Expected existing clients.chatgpt profile")
    allowed = clients["chatgpt"].get("allowed_workflows")
    if not isinstance(allowed, list):
        raise SystemExit("Expected clients.chatgpt.allowed_workflows list")
    if "powershell" not in clients["chatgpt"].get("allowed_executables", []):
        raise SystemExit("Client does not allow powershell. No policy changes made.")
    definitions = {}
    for mode, timeout, retry_safe in (
        ("probe", 120, True), ("test", 900, True), ("weights", 7200, False)
    ):
        name = "snarkroute_flux3_" + mode
        definitions[name] = {
            "executable": "powershell",
            "args": [
                "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", str(DST), "-Mode", mode
            ],
            "cwd_root": "snarkroute",
            "cwd": ".",
            "env": {},
            "timeout_seconds": timeout,
            "retry_safe": retry_safe,
        }
    for name, definition in definitions.items():
        current = doc["trusted_workflows"].get(name)
        if current is not None and current != definition:
            raise SystemExit(f"Conflicting owner policy entry: {name}. No changes made.")
    if DST.exists() and DST.read_bytes() != SRC.read_bytes():
        raise SystemExit(f"Owner runner differs: {DST}. Review manually; nothing changed.")
    original = CONFIG.read_bytes()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = CONFIG.with_name(CONFIG.name + "." + stamp + ".bak")
    shutil.copy2(CONFIG, backup)
    DST.parent.mkdir(parents=True, exist_ok=True)
    if not DST.exists():
        # Owner-protected directory: this copy is deliberately outside MCP-writable roots.
        shutil.copy2(SRC, DST)
    doc["trusted_workflows"].update(definitions)
    clients["chatgpt"]["allowed_workflows"] = list(dict.fromkeys([*allowed, *definitions]))
    updated = (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    try:
        atomic_write(CONFIG, updated)
    except Exception:
        if CONFIG.read_bytes() != original:
            shutil.copy2(backup, CONFIG)
        raise
    print("Configured exactly:", ", ".join(definitions))
    print("Protected owner runner:", DST)
    print("Owner policy backup:", backup)
    print("Restart SnarkBridge to reload owner policy before testing.")
    print("Other scopes, credentials, roots and executable allowlists were not changed.")

if __name__ == "__main__":
    main()
