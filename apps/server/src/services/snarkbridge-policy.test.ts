import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideBridgePending, listBridgePending, readBridgePolicy, setBridgeClientLevel } from "./snarkbridge-policy";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-policy-")); dirs.push(dir);
  const state = join(dir, "state"), path = join(dir, "bridge-config.json");
  writeFileSync(path, JSON.stringify({ schema_version: 1, state_dir: state, roots: {}, local_listener: { port: 8769 },
    clients: { chatgpt: { access_level: 2, scopes: ["a"], roots: ["r"], token_sha256: "secret-hash" }, tool: { scopes: [], roots: [] } } }));
  const digest = "b".repeat(64);
  mkdirSync(join(state, "pending"), { recursive: true });
  writeFileSync(join(state, "pending", `${digest}.json`), JSON.stringify({ digest, client: "chatgpt", operation: "process_start", payload: { args: ["x"] }, summary: "{\"args\":[\"x\"]}", reason: "P-11 risk filter (persistence)", at: "2026-11-04T05:00:00Z" }));
  return { path, state, digest };
}

describe("B3: политика SnarkBridge из Мастерской", () => {
  it("показывает уровни клиентов, но не их токены", () => {
    const f = fixture(); const policy = readBridgePolicy(f.path);
    expect(policy.clients).toEqual([{ id: "chatgpt", accessLevel: 2, level3ViaTunnel: false, scopes: 1, roots: 1 }, { id: "tool", accessLevel: 1, level3ViaTunnel: false, scopes: 0, roots: 0 }]);
    expect(JSON.stringify(policy)).not.toContain("secret-hash");
  });
  it("меняет только уровень и флаг туннеля, в пределах 0–3", () => {
    const f = fixture();
    expect(setBridgeClientLevel("chatgpt", { accessLevel: 3, level3ViaTunnel: true }, f.path)).toMatchObject({ accessLevel: 3, level3ViaTunnel: true });
    const saved = JSON.parse(readFileSync(f.path, "utf8"));
    expect(saved.clients.chatgpt).toMatchObject({ access_level: 3, level3_via_tunnel: true, token_sha256: "secret-hash", scopes: ["a"] });
    expect(() => setBridgeClientLevel("chatgpt", { accessLevel: 4 }, f.path)).toThrow(/0 до 3/);
    expect(() => setBridgeClientLevel("nobody", { accessLevel: 1 }, f.path)).toThrow(/Нет клиента/);
  });
  it("одобрение пишет одноразовое разрешение ровно на этот запрос; отказ убирает его из очереди", () => {
    const f = fixture();
    expect(listBridgePending(f.path)).toEqual([expect.objectContaining({ digest: f.digest, operation: "process_start", reason: expect.stringContaining("P-11") })]);
    expect(JSON.stringify(listBridgePending(f.path))).not.toContain("payload");
    const result = decideBridgePending(f.digest, "approve", f.path, 1000);
    const approval = JSON.parse(readFileSync(join(f.state, "approvals", `${result.approvalId}.json`), "utf8"));
    expect(approval).toEqual({ client: "chatgpt", operation: "process_start", digest: f.digest, expires: 1600 });
    expect(result.approvalId).toMatch(/^[0-9a-f]{32}$/);
    decideBridgePending(f.digest, "reject", f.path);
    expect(existsSync(join(f.state, "pending", `${f.digest}.json`))).toBe(false);
    expect(() => decideBridgePending("../../x", "approve", f.path)).toThrow(/идентификатор/);
    expect(readdirSync(join(f.state, "approvals"))).toHaveLength(1);
  });
});
