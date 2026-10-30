"""Verify the captured MCP snapshot against its metadata-only audit receipt."""
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

snapshot=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
audit=json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
created=datetime.fromisoformat(sys.argv[3].replace("Z","+00:00"))
expected=snapshot.pop("sha256")
actual=hashlib.sha256(json.dumps(snapshot,sort_keys=True).encode()).hexdigest()
assert expected==actual==audit["sha256"]
assert audit["client"]=="chatgpt" and audit["op"]=="browser.extension.snapshot" and audit["session_id"]=="default"
assert datetime.fromisoformat(audit["utc"])<created
assert "Отправленные" in snapshot["title"] and "buzha.studio@gmail.com" in snapshot["title"]
assert "Иллюстратор с нейросетями: отклик на объявление" in snapshot["text"]
assert "Кому: avtor" in snapshot["text"] and "Здравствуйте, Зухра!" in snapshot["text"]
print(json.dumps({"verified":True,"snapshotSha256":actual,"auditId":audit["id"],"observedAtUtc":audit["utc"],"taskCreatedAt":created.isoformat(),"sentMessageWasAlreadyVisible":True,"source":"authenticated SnarkBridge audit_log + byte-matching captured snapshot; not an inference from Gmail timezone"},ensure_ascii=False))
