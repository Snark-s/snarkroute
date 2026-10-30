"""Repair only visible DOM metadata in the existing Persona Bridge package.

Explicit owner-authorized infrastructure repair, not a permission change.
Backs up source/build first; never reloads Chrome or reads browser profile data.
Run with SnarkBridge's existing Python, then run the package's controlled tests.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import shutil
import subprocess
import sys

ROOT = Path(r"Y:\Приложения\Бужа\browser-extension-review-2026-10-29")
BACKUP = ROOT.parent / (".backup-telemetry-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
SOURCE = ROOT / "src/page-actions.js"
files = ["src/page-actions.js", "src/guard.js", "extension/background.js", "extension/manifest.json"]
BACKUP.mkdir(exist_ok=False)
for name in files:
    dest = BACKUP / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / name, dest)
before = SOURCE.read_text(encoding="utf-8")
old = "const label=e=>(e.getAttribute('aria-label')||e.getAttribute('title')||(!e.matches('input,textarea,[contenteditable]')?e.textContent:'')||[...(e.labels||[])].map(l=>l.textContent).join(' ')||'').trim().slice(0,250);"
new = "const label=e=>(e.getAttribute('aria-label')||e.getAttribute('title')||(e.matches('input[type=submit],input[type=button],input[type=reset]')?e.value:'')||(!e.matches('input,textarea,[contenteditable]')?e.textContent:'')||[...(e.labels||[])].map(l=>l.textContent).join(' ')||e.getAttribute('alt')||e.querySelector('img[alt]')?.getAttribute('alt')||'').trim().slice(0,250);"
if old not in before and new not in before:
    raise RuntimeError("Source changed: expected label implementation was not found; inspect before editing")
after = before.replace(old, new, 1)
after = after.replace("querySelectorAll('a,button,input,textarea,select,[role],[contenteditable]')", "querySelectorAll('a,button,input,textarea,select,label,[role],[contenteditable],[onclick],[tabindex]')")
old_snapshot = "elements,formStatus:forms(),messages:messages(),url:url(location.href)};"
new_snapshot = "elements,images:[...document.images].filter(visible).slice(0,30).map(e=>({alt:scrub(e.alt),src:url(e.currentSrc||e.src),width:e.naturalWidth,height:e.naturalHeight})),formStatus:forms(),messages:messages(),url:url(location.href)};"
assert old_snapshot in after or new_snapshot in after
after = after.replace(old_snapshot, new_snapshot, 1) if new_snapshot not in after else after
# Preserve only ordinary Gmail folder/message navigation, never arbitrary
# fragments (OAuth tokens, searches and credential flows remain stripped).
gmail_hash = "u.hash=(u.hostname==='mail.google.com'&&/^#(?:sent|all|inbox)(?:\\/[A-Za-z0-9_-]{10,100})?$/.test(u.hash))?u.hash:'';"
after = after.replace("u.hash='';", gmail_hash, 1)
SOURCE.write_text(after, encoding="utf-8")
guard_path = ROOT / "src/guard.js"
guard = guard_path.read_text(encoding="utf-8")
guard_path.write_text(guard.replace("url.hash='';", gmail_hash.replace("u.", "url."), 1), encoding="utf-8")
subprocess.run([sys.executable, str(ROOT / "build.py")], check=True)
assert (ROOT / "extension/manifest.json").read_bytes() == (BACKUP / "extension/manifest.json").read_bytes(), "Manifest changed: do not load until reviewed"
proof = {"at": datetime.now(timezone.utc).isoformat(), "backup": str(BACKUP), "source": str(SOURCE), "beforeSha256": hashlib.sha256(before.encode()).hexdigest(), "afterSha256": hashlib.sha256(after.encode()).hexdigest(), "manifestUnchanged": True, "loadedInChrome": False, "scope": "visible labels/selectors/image metadata only; central policy unchanged"}
(BACKUP / "repair.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(proof, ensure_ascii=False))
