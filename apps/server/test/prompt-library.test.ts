import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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

  it("creates generated image prompt assets as markdown with a sibling preview", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const directory = join(tmpdir(), `sr-server-prompt-asset-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(directory, { recursive: true });
    process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = directory;

    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/prompt-library/generated-image",
        payload: {
          title: "Crystal Forest",
          slug: "crystal-forest",
          category: "image-generation",
          description: "Reusable generated recipe.",
          tags: ["image", "generated"],
          prompt: "A crystal forest at sunrise.",
          negativePrompt: "blur",
          modelHints: ["stable-diffusion"],
          source: { runId: "run-1", routeId: "route-1", nodeId: "node-1", outputId: "image" },
          imageDataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        }
      });
      expect(created.statusCode).toBe(200);
      const promptPath = join(directory, "image-generation", "crystal-forest.prompt.md");
      const previewPath = join(directory, "image-generation", "crystal-forest.preview.png");
      await access(previewPath);
      const text = await readFile(promptPath, "utf8");
      expect(text).toContain("status: candidate");
      expect(text).toContain("previewImage: crystal-forest.preview.png");
      expect(text).toContain("type: generated-image");
      expect(text).toContain("A crystal forest at sunrise.");
      expect(created.json().library.categories[0].prompts[0]).toMatchObject({ id: "crystal-forest", status: "candidate", text: "A crystal forest at sunrise." });

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/prompt-library/generated-image",
        payload: {
          title: "Crystal Forest",
          slug: "crystal-forest",
          category: "image-generation",
          prompt: "A crystal forest at sunrise.",
          imageDataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        }
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.json().error).toContain("already exists");
    } finally {
      await app.close();
    }
  });

  it("can create generated image prompt assets as canonical embedded prompt PNGs", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const directory = join(tmpdir(), `sr-server-prompt-png-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(directory, { recursive: true });
    process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = directory;

    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/prompt-library/generated-image",
        payload: {
          title: "Embedded Forest",
          slug: "embedded-forest",
          category: "image-generation",
          prompt: "A forest carried inside PNG metadata.",
          negativePrompt: "blur",
          assetFormat: "png",
          imageDataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        }
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().promptPath).toContain("embedded-forest.prompt.png");
      expect(created.json().library.categories[0].prompts[0]).toMatchObject({
        title: "Embedded Forest",
        text: "A forest carried inside PNG metadata.",
        negativePrompt: "blur",
        previewImage: "embedded-forest.prompt.png"
      });
    } finally {
      await app.close();
    }
  });

  it("updates prompt asset status and category without deleting the file", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const directory = join(tmpdir(), `sr-server-prompt-move-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(directory, "drafts"), { recursive: true });
    process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = directory;
    await writeFile(
      join(directory, "drafts", "demo.prompt.md"),
      "---\nid: demo\ntitle: Demo\ncategory: drafts\nstatus: draft\n---\n\nPrompt body.\n",
      "utf8"
    );

    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const updated = await app.inject({
        method: "PATCH",
        url: "/api/prompt-library/drafts/demo",
        payload: { status: "approved", category: "published" }
      });
      expect(updated.statusCode).toBe(200);
      const movedPath = join(directory, "published", "demo.prompt.md");
      const text = await readFile(movedPath, "utf8");
      expect(text).toContain("category: published");
      expect(text).toContain("status: approved");
      expect(updated.json().library.categories[0].prompts[0]).toMatchObject({ id: "demo", category: "published", status: "approved" });
    } finally {
      await app.close();
    }
  });

  it("deletes markdown prompt assets from the local library", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const directory = join(tmpdir(), `sr-server-prompt-delete-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(directory, "drafts"), { recursive: true });
    process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = directory;
    await writeFile(
      join(directory, "drafts", "demo.prompt.md"),
      "---\nid: demo\ntitle: Demo\ncategory: drafts\nstatus: draft\n---\n\nPrompt body.\n",
      "utf8"
    );

    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const deleted = await app.inject({ method: "DELETE", url: "/api/prompt-library/drafts/demo" });
      expect(deleted.statusCode).toBe(200);
      const refreshed = await app.inject({ method: "GET", url: "/api/prompt-library" });
      expect(refreshed.json().categories).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
