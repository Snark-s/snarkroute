import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { privateGatewayUrl, SmsGateway } from "./sms-gateway";

describe("SMS Gateway for Android as a read-only inbox", () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

  it("accepts only home-network, loopback or Tailscale addresses", () => {
    expect(privateGatewayUrl("192.168.1.23:8080")).toBe("http://192.168.1.23:8080");
    expect(privateGatewayUrl("http://100.101.2.3:8080/")).toBe("http://100.101.2.3:8080");
    expect(() => privateGatewayUrl("api.sms-gate.app")).toThrow(/домашней сети/);
  });

  it("saves only after the phone answers, keeps the password encrypted and reads the inbox newest first", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sms-gw-")); dirs.push(directory);
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("limit=1&") || url.endsWith("limit=1") ? [] : [
      { id: "a", type: "SMS", sender: "Telegram", contentPreview: "Code 12345", createdAt: "2026-11-05T10:00:00Z" },
      { id: "b", type: "SMS", sender: "Bank", contentPreview: "x", createdAt: "2026-11-05T11:00:00Z" }])));
    const gateway = new SmsGateway({ directory, fetchImpl: fetchImpl as never });
    await expect(new SmsGateway({ directory, fetchImpl: (async () => new Response("", { status: 401 })) as never }).configure({ url: "192.168.1.5:8080", username: "sms", password: "secret-pass" })).rejects.toThrow(/логин или пароль/);
    expect((await gateway.status()).configured).toBe(false);
    expect(await gateway.configure({ url: "192.168.1.5:8080", username: "sms", password: "secret-pass" })).toMatchObject({ configured: true, url: "http://192.168.1.5:8080", username: "sms" });
    expect(await readFile(join(directory, "sms-gateway.json"), "utf8")).not.toContain("secret-pass");
    expect(JSON.stringify(await gateway.status())).not.toContain("secret-pass");
    const inbox = await gateway.inbox({ limit: 10 });
    expect(inbox.messages.map(message => message.id)).toEqual(["b", "a"]);
    expect((await gateway.inbox({ sender: "telegram" })).messages).toEqual([expect.objectContaining({ id: "a", text: "Code 12345" })]);
    expect((fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: `Basic ${Buffer.from("sms:secret-pass").toString("base64")}` });
    await gateway.disconnect();
    await expect(gateway.inbox()).rejects.toThrow(/не подключён/);
  });
});
