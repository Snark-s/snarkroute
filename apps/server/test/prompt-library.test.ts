import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("prompt library API", () => {
  afterEach(() => {
    delete process.env.SNARKROUTE_NO_LISTEN;
    delete process.env.SNARKROUTE_PROMPT_LIBRARY_PATH;
  });

  it("refresh rescans newly added prompt files", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const directory = join(tmpdir(), `sr-server-prompt-library-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(directory, { recursive: true });
    process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = directory;

    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const empty = await app.inject({ method: "GET", url: "/api/prompt-library" });
      expect(empty.statusCode).toBe(200);
      expect(empty.json().categories).toEqual([]);

      await mkdir(join(directory, "image-generation"), { recursive: true });
      await writeFile(
        join(directory, "image-generation", "demo.prompt.md"),
        "---\nid: demo\ntitle: Demo\ncategory: image-generation\n---\n\nFresh prompt text.\n",
        "utf8"
      );

      const refreshed = await app.inject({ method: "POST", url: "/api/prompt-library/refresh" });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().categories[0].prompts[0]).toMatchObject({ id: "demo", text: "Fresh prompt text." });
    } finally {
      await app.close();
    }
  });
});
