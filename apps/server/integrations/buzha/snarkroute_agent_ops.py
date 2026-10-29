"""Client of SnarkRoute agent operations for an agent that SnarkRoute launches.

SnarkRoute sets at launch: SNARKROUTE_AGENT_ID, SNARKROUTE_AGENT_TOKEN (signed by the
server, agent policy), SNARKROUTE_API_URL and SNARKROUTE_AGENT_BRIEF. With the token
every SnarkRoute request of this agent is identified: its model and GPU work goes
through the shared dispatcher (computer mode, resource leases), its delegated tasks
through the shared queue, quota ledger and acceptance. Without the token the agent is
not connected and must not pretend to be (``connected`` is False).

Kept identical in Tove, Factory, Бужа and PersonaCore; standard library only.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Mapping

TERMINAL = {"verified", "failed", "cancelled"}
WAITING = {"queued", "waiting_window", "waiting_resources", "waiting_executor"}
RENEW_AFTER_S = 24 * 3600


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


class AgentOpsError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, code: str | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


class AgentOpsClient:
    def __init__(self, env: Mapping[str, str] | None = None):
        env = os.environ if env is None else env
        self.api = (env.get("SNARKROUTE_API_URL") or "http://127.0.0.1:4317").rstrip("/")
        self.agent_id = env.get("SNARKROUTE_AGENT_ID") or ""
        self.brief = env.get("SNARKROUTE_AGENT_BRIEF") or ""
        self._token = env.get("SNARKROUTE_AGENT_TOKEN") or ""
        self._renewed_at = time.monotonic()
        self._lock = threading.Lock()
        self._heavy_cache: tuple[float, tuple[bool, str]] | None = None

    @property
    def connected(self) -> bool:
        return bool(self._token)

    def headers(self) -> dict[str, str]:
        self._maybe_renew()
        return {"x-snarkroute-agent-token": self._token} if self._token else {}

    def owns(self, url: str) -> bool:
        """True for URLs of this SnarkRoute: only they receive the agent token."""
        return url.startswith(self.api + "/") or url == self.api

    # -- transport -------------------------------------------------------------
    def _request(self, method: str, path: str, payload: Any = None, timeout: float = 30, renew: bool = True) -> Any:
        if not self._token:
            raise AgentOpsError("Агент не подключён к SnarkRoute: нет SNARKROUTE_AGENT_TOKEN (запустите его из Мастерской).", code="NOT_CONNECTED")
        headers = {"Content-Type": "application/json", "x-snarkroute-agent-token": self._token}
        if renew:
            headers = {**headers, **self.headers()}
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.api + path, data=data, method=method, headers=headers)
        try:
            with _OPENER.open(request, timeout=timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                body = json.loads(raw.decode("utf-8", errors="replace"))
            except ValueError:
                body = {"error": raw[:500].decode("utf-8", errors="replace")}
            raise AgentOpsError(str(body.get("error") or f"HTTP {error.code}"), error.code, body.get("code"), body) from None
        except (urllib.error.URLError, OSError) as error:
            raise AgentOpsError(f"SnarkRoute недоступен: {getattr(error, 'reason', error)}", code="UNREACHABLE") from None
        return json.loads(raw.decode("utf-8")) if raw else None

    def _maybe_renew(self) -> None:
        if not self._token or time.monotonic() - self._renewed_at < RENEW_AFTER_S:
            return
        with self._lock:
            if time.monotonic() - self._renewed_at < RENEW_AFTER_S:
                return
            try:
                body = self._request("POST", "/api/agent-ops/token/refresh", {}, timeout=10, renew=False)
                self._token = body.get("token") or self._token
            except AgentOpsError:
                pass
            self._renewed_at = time.monotonic()

    # -- catalog, mode, resources ------------------------------------------------
    def whoami(self) -> dict[str, Any]:
        return self._request("GET", "/api/agent-ops/whoami")

    def catalog(self, kind: str | None = None, query: str | None = None, available_only: bool = False) -> list[dict[str, Any]]:
        params = [f"kind={kind}" if kind else "", f"query={urllib.request.quote(query)}" if query else "", "availableOnly=1" if available_only else ""]
        suffix = "&".join(part for part in params if part)
        return self._request("GET", "/api/agent-ops/catalog" + (f"?{suffix}" if suffix else "")).get("entries", [])

    def admission(self, resource_class: str = "heavy", vram_mib: int | None = None, runtime_id: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"class": resource_class}
        if vram_mib is not None:
            payload["vramMiB"] = vram_mib
        if runtime_id:
            payload["runtimeId"] = runtime_id
        return self._request("POST", "/api/agent-ops/admission", payload, timeout=15)

    def heavy_allowed(self, max_age_s: float = 30.0) -> tuple[bool, str]:
        """May this agent start heavy GPU work now (computer mode, measured load, free VRAM)? Cached briefly."""
        now = time.monotonic()
        if self._heavy_cache and now - self._heavy_cache[0] < max_age_s:
            return self._heavy_cache[1]
        try:
            decision = self.admission("heavy")
            result = (bool(decision.get("granted")), str(decision.get("reason") or "разрешено диспетчером SnarkRoute"))
        except AgentOpsError as error:
            result = (False, f"диспетчер SnarkRoute не ответил: {error}")
        self._heavy_cache = (now, result)
        return result

    # -- delegation ------------------------------------------------------------
    def submit(self, spec: Mapping[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/agent-ops/tasks", dict(spec), timeout=30)["task"]

    def status(self, task_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/agent-ops/tasks/{task_id}")

    def result(self, task_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/agent-ops/tasks/{task_id}/result")

    def cancel(self, task_id: str) -> dict[str, Any]:
        return self._request("POST", f"/api/agent-ops/tasks/{task_id}/cancel", {})

    def wait(self, task_id: str, timeout_s: float, poll_s: float = 3.0) -> dict[str, Any]:
        """Polls until the task is accepted, failed or cancelled, or the timeout passes; the task keeps running in SnarkRoute."""
        deadline = time.monotonic() + max(0.0, timeout_s)
        while True:
            task = self.status(task_id)["task"]
            if task["state"] in TERMINAL or time.monotonic() >= deadline:
                return task
            time.sleep(poll_s)

    def delegate(self, goal: str, *, workspace: str | None = None, acceptance: list[str] | None = None,
                 checks: list[dict[str, Any]] | None = None, idempotency_key: str | None = None,
                 executor: str = "auto", wait_s: float = 0.0, **extra: Any) -> dict[str, Any]:
        """Hands a task to the best suitable executor. Reusing ``idempotency_key`` reattaches to the same task."""
        spec: dict[str, Any] = {"goal": goal, "executor": executor, **extra}
        if workspace:
            spec["workspace"] = workspace
        if acceptance:
            spec["acceptance"] = acceptance
        if checks:
            spec["checks"] = checks
        if idempotency_key:
            spec["idempotencyKey"] = idempotency_key
        task = self.submit(spec)
        return self.wait(task["id"], wait_s) if wait_s > 0 else task


_DEFAULT: AgentOpsClient | None = None
_DEFAULT_LOCK = threading.Lock()


def client() -> AgentOpsClient:
    global _DEFAULT
    with _DEFAULT_LOCK:
        if _DEFAULT is None:
            _DEFAULT = AgentOpsClient()
        return _DEFAULT


def snarkroute_headers(url: str) -> dict[str, str]:
    """Headers to add to a request: the agent token, but only for this SnarkRoute."""
    agent = client()
    return agent.headers() if agent.connected and agent.owns(url) else {}


__all__ = ["AgentOpsClient", "AgentOpsError", "client", "snarkroute_headers", "TERMINAL", "WAITING"]
