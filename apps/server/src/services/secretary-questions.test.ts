import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretaryInboxService } from "./secretary-inbox";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(rows: unknown[][], writePause?: Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "secretary-questions-")); directories.push(dir);
  const keyPath = join(dir, "key.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, JSON.stringify({ client_email: "test@example.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
  let fail = false;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2")) {
      const assertion = new URLSearchParams(init?.body as URLSearchParams).get("assertion")!;
      const scope = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString()).scope;
      return Response.json({ access_token: scope.endsWith(".readonly") ? "read-token" : "write-token", expires_in: 3600 });
    }
    if (fail) return Response.json({}, { status: 503 });
    if (init?.method === "PUT") {
      await writePause;
      const range = decodeURIComponent(new URL(url).pathname.split("/values/")[1]);
      const row = Number(range.match(/F(\d+)$/)?.[1]);
      rows[row - 2][5] = JSON.parse(String(init.body)).values[0][0];
      return Response.json({ updatedCells: 1 });
    }
    return Response.json({ values: rows });
  });
  let time = 5_000_000;
  const service = createSecretaryInboxService({ fetchImpl: fetchImpl as typeof fetch, keyPath, now: () => time });
  const writes = () => fetchImpl.mock.calls.filter(([, init]) => init?.method === "PUT");
  return { service, fetchImpl, writes, fail: () => { fail = true; time += 61_000; } };
}

describe("secretary questions", () => {
  it("maps the registry columns, ignores headings and separates answered and withdrawn questions", async () => {
    const { service } = fixture([
      ["Номер", "Дата", "Агент", "Вопрос"],
      ["17", "26.10", "Шорёк", "Продолжать?", "да / нет", "", "контекст"],
      ["18", "26.10", "Фабрика", "Готово?", "", "да"],
      ["19", "26.10", "Фабрика", "Позже?", "", "", "Снято: уже выполнено"]
    ]);
    const result = await service.questions();
    expect(result.pending).toBe(1);
    expect(result.questions).toEqual([
      { id: "17", date: "26.10", agent: "Шорёк", question: "Продолжать?", suggestions: "да / нет", answer: "", note: "контекст", closed: false },
      { id: "18", date: "26.10", agent: "Фабрика", question: "Готово?", suggestions: "", answer: "да", note: "", closed: false },
      { id: "19", date: "26.10", agent: "Фабрика", question: "Позже?", suggestions: "", answer: "", note: "Снято: уже выполнено", closed: true }
    ]);
  });

  it("re-reads the current row by id, writes only its answer as RAW text and refreshes the shared count", async () => {
    const rows = [["17", "", "Шорёк", "Продолжать?"], ["18", "", "Фабрика", "Готово?"]];
    const { service, writes } = fixture(rows);
    expect((await service.summary()).pending).toBe(2);
    rows.reverse();
    const result = await service.answer("17", "=ответ как текст", "Продолжать?");
    expect(result.pending).toBe(1);
    const [url, init] = writes()[0];
    expect(init?.headers).toMatchObject({ Authorization: "Bearer write-token" });
    expect(writes()).toHaveLength(1);
    expect(decodeURIComponent(String(url))).toContain("Решения!F3?valueInputOption=RAW");
    expect(JSON.parse(String(init?.body))).toEqual({ values: [["=ответ как текст"]] });
    expect((await service.summary()).pending).toBe(1);
    expect((await service.questions()).questions.find(q => q.id === "17")?.answer).toBe("=ответ как текст");
    await service.answer("17", "=ответ как текст", "Продолжать?");
    expect(writes()).toHaveLength(1);
  });

  it.each([
    { rows: [["17", "", "", "Вопрос", "", "чужой ответ"]], question: "Вопрос" },
    { rows: [["17", "", "", "Вопрос", "", "", "Закрыто"]], question: "Вопрос" },
    { rows: [["17", "", "", "Новый вопрос"]], question: "Старый вопрос" },
    { rows: [["17", "", "", "Вопрос"], ["17", "", "", "Дубликат"]], question: "Вопрос" }
  ])("refuses stale, closed, answered or ambiguous questions without writing: $rows", async ({ rows, question }) => {
    const { service, writes } = fixture(rows);
    await expect(service.answer("17", "да", question)).rejects.toMatchObject({ statusCode: 409 });
    expect(writes()).toHaveLength(0);
  });

  it("serializes simultaneous answers and never overwrites the first answer", async () => {
    const { service, writes } = fixture([["17", "", "", "Вопрос"]]);
    const results = await Promise.allSettled([service.answer("17", "да", "Вопрос"), service.answer("17", "нет", "Вопрос")]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(writes()).toHaveLength(1);
  });

  it("rejects missing questions and invalid answers before any write", async () => {
    const { service, writes } = fixture([]);
    await expect(service.answer("17", "да", "Вопрос")).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.answer("17", " ", "Вопрос")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.answer("17", "а".repeat(10001), "Вопрос")).rejects.toMatchObject({ statusCode: 400 });
    expect(writes()).toHaveLength(0);
  });

  it("waits for a pending save before refreshing the list or badge", async () => {
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const { service, writes } = fixture([["17", "", "", "Вопрос"]], pause);
    const saving = service.answer("17", "да", "Вопрос");
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    let readFinished = false;
    const reading = service.questions().then(result => { readFinished = true; return result; });
    const count = service.summary();
    await Promise.resolve();
    expect(readFinished).toBe(false);
    release();
    await saving;
    expect((await reading).pending).toBe(0);
    expect((await count).pending).toBe(0);
  });

  it("keeps the last good count on upstream failure and exposes an error instead of an empty inbox", async () => {
    const { service, fail } = fixture([["17", "", "", "Вопрос"]]);
    expect((await service.summary()).pending).toBe(1);
    fail();
    await expect(service.questions()).rejects.toMatchObject({ statusCode: 503 });
    expect(await service.summary()).toMatchObject({ pending: 1, error: expect.any(String) });
  });
});
