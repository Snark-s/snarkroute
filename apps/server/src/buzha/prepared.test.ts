import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buzhaPrepared } from "./prepared";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("lists well-formed prepared requests and skips malformed or oversized ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buzha-prepared-")); dirs.push(dir);
  await writeFile(join(dir, "a.json"), JSON.stringify({ title: "Профиль", preparedBy: "mcp:claude-code", preparedAt: "2026-10-30", summary: ["Критерий"], body: { content: "Оформи профиль", requestKey: "k1", quality: "high", contract: { checks: [] } } }));
  await writeFile(join(dir, "b.json"), "{not json");
  await writeFile(join(dir, "c.json"), JSON.stringify({ title: "Без тела" }));
  await writeFile(join(dir, "d.json"), JSON.stringify({ title: "Огромное", body: { content: "x".repeat(40001), requestKey: "k2" } }));
  await writeFile(join(dir, "../outside.json"), "{}").catch(() => undefined);
  const prepared = await buzhaPrepared(dir);
  expect(prepared.map(item => item.file)).toEqual(["a.json"]);
  expect(prepared[0].body).toEqual({ content: "Оформи профиль", requestKey: "k1", quality: "high", contract: { checks: [] } });
  expect(await buzhaPrepared(join(dir, "missing"))).toEqual([]);
});
