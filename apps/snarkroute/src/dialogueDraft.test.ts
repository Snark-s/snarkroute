import { describe, expect, it } from "vitest";
import { readTextDialogueDraft, writeTextDialogueDraft } from "./dialogueDraft";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); }
  };
}

describe("text dialogue draft", () => {
  it("restores a draft only for its node", () => {
    const storage = memoryStorage();
    writeTextDialogueDraft(storage, "text-1", "unfinished reply");
    expect(readTextDialogueDraft(storage, "text-1")).toBe("unfinished reply");
    expect(readTextDialogueDraft(storage, "text-2")).toBe("");
  });

  it("removes a sent draft", () => {
    const storage = memoryStorage();
    writeTextDialogueDraft(storage, "text-1", "sent reply");
    writeTextDialogueDraft(storage, "text-1", "");
    expect(storage.length).toBe(0);
  });
});
