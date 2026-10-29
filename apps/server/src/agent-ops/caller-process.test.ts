import { describe, expect, it } from "vitest";
import { CallerAttribution, isModelWorkRequest } from "./caller-process";

const processes = [
  { pid: 1, ppid: 0, name: "explorer" },
  { pid: 10, ppid: 1, name: "chrome" },
  { pid: 20, ppid: 1, name: "photoshop" },
  { pid: 30, ppid: 1, name: "python" }, { pid: 31, ppid: 30, name: "python" },
  { pid: 40, ppid: 1, name: "codex" }, { pid: 41, ppid: 40, name: "powershell" }, { pid: 42, ppid: 41, name: "node" },
  { pid: 50, ppid: 1, name: "cmd" }, { pid: 51, ppid: 50, name: "node" },
  { pid: 60, ppid: 999, name: "bash" }, { pid: 61, ppid: 60, name: "node" },
  { pid: 70, ppid: 998, name: "mixar" }, { pid: 71, ppid: 70, name: "python" }
];
const connections = [10, 20, 31, 42, 51, 61, 71].map((pid, index) => ({ localPort: 50_000 + index, remotePort: 4317, pid }));

describe("caller attribution", () => {
  const callers = new CallerAttribution({ connections: async () => connections, processes: async () => processes, agentRoots: () => new Map([[30, "app:tove"]]) });

  it("treats tokenless calls from an agent's process tree as that agent", async () => {
    expect(await callers.attribute(50_002, 4317)).toMatchObject({ kind: "agent", agentId: "app:tove" });
    expect(await callers.attribute(50_003, 4317)).toMatchObject({ kind: "agent", agentId: "host:codex" });
  });

  it("keeps browsers, Adobe hosts and other owner programs interactive and unknown callers unknown", async () => {
    expect(await callers.attribute(50_000, 4317)).toMatchObject({ kind: "interactive", client: "chrome" });
    expect(await callers.attribute(50_001, 4317)).toMatchObject({ kind: "interactive", client: "photoshop" });
    expect(await callers.attribute(50_004, 4317)).toMatchObject({ kind: "interactive", client: "node" });
    expect(await callers.attribute(59_999, 4317)).toMatchObject({ kind: "unknown" });
    // An orphaned shell chain is not trusted as the owner; an orphaned chain inside Mixar still is Mixar.
    expect(await callers.attribute(50_005, 4317)).toMatchObject({ kind: "unknown" });
    expect(await callers.attribute(50_006, 4317)).toMatchObject({ kind: "interactive", client: "mixar" });
  });

  it("attributes only requests that start model or GPU work", () => {
    expect(isModelWorkRequest("POST", "/api/routes/run")).toBe(true);
    expect(isModelWorkRequest("POST", "/api/model-gateway/jobs")).toBe(true);
    expect(isModelWorkRequest("GET", "/api/model-gateway/jobs/x")).toBe(false);
    expect(isModelWorkRequest("POST", "/api/system/local-runtimes/flux3/start")).toBe(true);
  });
});
