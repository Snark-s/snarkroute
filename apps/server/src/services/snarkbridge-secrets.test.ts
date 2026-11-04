import { describe, expect, it } from "vitest";
import { deleteBridgeSecret, listBridgeSecrets, normalizeOrigins, setBridgeSecret, type VaultRunner } from "./snarkbridge-secrets";

function fakeVault() {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run: VaultRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "list") return JSON.stringify([{ ref: "fl-login", origins: ["https://www.fl.ru"], updated: "2026-11-04T09:00:00" }]);
    return "{}";
  };
  return { calls, run };
}

describe("SnarkBridge secrets (P-04)", () => {
  it("passes the value on stdin only, never in arguments", async () => {
    const vault = fakeVault();
    const result = await setBridgeSecret({ ref: "fl-login", origins: "fl.ru, https://www.fl.ru/login", value: "S3cr3t Пароль" }, vault.run);
    expect(result).toEqual({ ref: "fl-login", origins: ["https://fl.ru", "https://www.fl.ru"] });
    expect(vault.calls[0].args).toEqual(["set", "fl-login", JSON.stringify(["https://fl.ru", "https://www.fl.ru"])]);
    expect(vault.calls[0].args.join(" ")).not.toContain("S3cr3t");
    expect(vault.calls[0].stdin).toBe("S3cr3t Пароль");
    expect(JSON.stringify(result)).not.toContain("S3cr3t");
  });

  it("rejects bad names, plain http and empty or multi-line values", async () => {
    const vault = fakeVault();
    await expect(setBridgeSecret({ ref: "Bad Name", origins: ["https://a.ru"], value: "x" }, vault.run)).rejects.toThrow(/Имя/);
    await expect(setBridgeSecret({ ref: "a", origins: ["http://a.ru"], value: "x" }, vault.run)).rejects.toThrow(/https/);
    await expect(setBridgeSecret({ ref: "a", origins: [], value: "x" }, vault.run)).rejects.toThrow(/сайт/);
    await expect(setBridgeSecret({ ref: "a", origins: ["https://a.ru"], value: "x\ny" }, vault.run)).rejects.toThrow(/перевод/);
    await expect(deleteBridgeSecret("../x", vault.run)).rejects.toThrow();
    expect(vault.calls).toHaveLength(0);
    expect(normalizeOrigins(["https://A.ru/path"])).toEqual(["https://a.ru"]);
  });

  it("lists names and sites without values and deletes by name", async () => {
    const vault = fakeVault();
    expect(await listBridgeSecrets(vault.run)).toEqual([{ ref: "fl-login", origins: ["https://www.fl.ru"], updated: "2026-11-04T09:00:00" }]);
    expect(await deleteBridgeSecret("fl-login", vault.run)).toEqual({ ref: "fl-login", deleted: true });
    expect(vault.calls.at(-1)?.args).toEqual(["delete", "fl-login"]);
  });
});
