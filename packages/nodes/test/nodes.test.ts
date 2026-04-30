import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutor } from "@snarkroute/executor";
import { registerBuiltInNodeRunners } from "../src/index";

describe("built-in nodes", () => {
  it("output.file writes to the run folder", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-node-"));
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);

    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "file-test", title: "File Test", author: {} },
        economics: { enabled: false },
        nodes: [
          { id: "input", type: "input.text", params: { value: "hello file" } },
          { id: "output", type: "output.file", params: { filename: "hello.txt", from: "{{input.output.text}}" } }
        ],
        edges: [{ from: "input", to: "output" }]
      },
      { outputDirectory }
    );

    expect(result.status).toBe("succeeded");
    expect(await readFile(join(outputDirectory, "hello.txt"), "utf8")).toBe("hello file");
  });

  it("input.file succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-node-"));
    const filePath = join(directory, "sample.txt");
    await writeFile(filePath, "hello");
    const result = await executeSingleAssetNode("input.file", filePath);
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.asset.output).toMatchObject({ filename: "sample.txt", mimeType: "text/plain", sizeBytes: 5 });
  });

  it("input.file missing file fails", async () => {
    const result = await executeSingleAssetNode("input.file", join(tmpdir(), "missing-snarkroute-file.txt"));
    expect(result.status).toBe("failed");
    expect(result.nodeResults.asset.error).toContain("was not found");
  });

  it("input.image succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-node-"));
    const filePath = join(directory, "pixel.png");
    await writeFile(filePath, tinyPng());
    const result = await executeSingleAssetNode("input.image", filePath);
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.asset.output).toMatchObject({ filename: "pixel.png", mimeType: "image/png", width: 1, height: 1 });
  });

  it("input.image wrong mime type fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-node-"));
    const filePath = join(directory, "not-image.txt");
    await writeFile(filePath, "not an image");
    const result = await executeSingleAssetNode("input.image", filePath);
    expect(result.status).toBe("failed");
    expect(result.nodeResults.asset.error).toContain("expected an image file");
  });

  it("input.video succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-node-"));
    const filePath = join(directory, "sample.mp4");
    await writeFile(filePath, Buffer.from("not-real-video-but-local-metadata"));
    const result = await executeSingleAssetNode("input.video", filePath);
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.asset.output).toMatchObject({ filename: "sample.mp4", mimeType: "video/mp4" });
  });

  it("input.video missing file fails", async () => {
    const result = await executeSingleAssetNode("input.video", join(tmpdir(), "missing-snarkroute-video.mp4"));
    expect(result.status).toBe("failed");
    expect(result.nodeResults.asset.error).toContain("was not found");
  });
});

async function executeSingleAssetNode(type: string, path: string) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "sr-node-run-"));
  const executor = createExecutor();
  registerBuiltInNodeRunners(executor);
  return executor.executeRoute(
    {
      routeVersion: "0.1",
      route: { id: "asset-test", title: "Asset Test", author: {} },
      economics: { enabled: false },
      nodes: [{ id: "asset", type, params: { path } }],
      edges: []
    },
    { outputDirectory }
  );
}

function tinyPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  );
}
