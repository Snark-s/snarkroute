import { mkdtemp, readFile } from "node:fs/promises";
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
});
