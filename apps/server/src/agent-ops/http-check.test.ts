import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck } from "./workspace";

// A public profile page served like FL.ru: UTF-8 lines next to a windows-1251 line.
const utf8 = Buffer.from('<img alt="Фрилансер Бужа Студия Генерация изображений buzhastudio" class="b-layout__pic">\n<a href="/user/buzhastudio/portfolio/101/" title="Стикеры">\n<a href="/user/buzhastudio/portfolio/101/" title="Стикеры">\n<a href="/user/buzhastudio/portfolio/102/" title="Стикеры">\n', "utf8");
const legacy = Buffer.from([0xcd, 0xe5, 0xf2, 0x20, 0xf0, 0xe0, 0xe1, 0xee, 0xf2, 0x0a]); // «Нет работ» in windows-1251
let url = "";
const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(Buffer.concat([utf8, legacy])); });
beforeAll(async () => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe("http check", () => {
  it("decodes mixed UTF-8 and windows-1251 pages line by line", async () => {
    expect((await runCheck({ type: "http", url, text: "Студия Генерация изображений buzhastudio" }, undefined)).ok).toBe(true);
    expect((await runCheck({ type: "http", url, text: "Нет работ" }, undefined)).ok).toBe(true);
  });
  it("fails when absentText is present", async () => {
    expect((await runCheck({ type: "http", url, absentText: "Нет работ" }, undefined)).ok).toBe(false);
    expect((await runCheck({ type: "http", url, absentText: "no_foto_b.png" }, undefined)).ok).toBe(true);
  });
  it("counts pattern matches, distinct by the first group", async () => {
    const work = 'portfolio/(\\d+)/" title="Стикеры"';
    expect((await runCheck({ type: "http", url, pattern: work, matches: { min: 1, max: 1, distinct: true } }, undefined)).ok).toBe(false);
    expect((await runCheck({ type: "http", url, pattern: work, matches: { min: 2, max: 2, distinct: true } }, undefined)).ok).toBe(true);
    expect((await runCheck({ type: "http", url, pattern: work, matches: { min: 3, max: 3 } }, undefined)).ok).toBe(true);
  });
});
