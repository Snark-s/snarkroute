import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countPending, readSecretaryInbox, signedAssertion } from "./secretary-inbox";

describe("secretary inbox", () => {
  it("counts numbered questions without an answer", () => {
    expect(countPending([
      ["1", "2026-10-20", "Шорёк", "Вопрос?", "да / нет", "да"],
      ["2", "2026-10-20", "Фабрика", "Ещё вопрос?", "да / нет"],
      ["3", "2026-10-20", "Раскрутка", "Третий?", "да / нет", "  "],
      ["", "", "", "", "", ""],
      ["заголовок", "", "", "Не вопрос", "", ""]
    ])).toBe(2);
    expect(countPending(undefined)).toBe(0);
  });

  it("does not count questions the agents closed in column G", () => {
    expect(countPending([
      ["51", "2026-10-21", "Фабрика", "Согласовать дизайн?", "да / нет", "", "снято: создано по ошибке, отвечать не нужно"],
      ["45", "2026-10-21", "Фабрика", "Нечем заняться?", "сделал / позже", "", "Исполнено: ответ в №75"],
      ["76", "2026-10-21", "Фабрика", "Открытый вопрос?", "да / нет", "", "Шорёк"]
    ])).toBe(1);
  });

  it("signs a verifiable RS256 assertion and reads the count through the Sheets API", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const assertion = signedAssertion({ client_email: "a@b", private_key: pem }, 1000);
    const [header, claims, signature] = assertion.split(".");
    const verify = createVerify("RSA-SHA256"); verify.update(`${header}.${claims}`);
    expect(verify.verify(publicKey, Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "sec-"));
    try {
      const keyPath = join(dir, "key.json");
      writeFileSync(keyPath, JSON.stringify({ client_email: "a@b", private_key: pem }));
      const fetchImpl = (async (url: string) => String(url).includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
        : new Response(JSON.stringify({ values: [["1", "", "", "Q", "", ""], ["2", "", "", "Q", "", "да"]] }))) as unknown as typeof fetch;
      const inbox = await readSecretaryInbox({ fetchImpl, keyPath, now: () => 5_000_000 });
      expect(inbox).toMatchObject({ pending: 1 });
      expect(JSON.stringify(inbox)).not.toContain("PRIVATE KEY");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
