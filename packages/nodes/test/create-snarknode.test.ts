import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installNodePackageFromArchive, previewNodePackageArchive, validateNodeManifest } from "../src/index";
import { createSnarkNodePackage } from "../../../scripts/create-snarknode";

const execFileAsync = promisify(execFile);

describe("create-snarknode skill generator", () => {
  it("creates a minimal declarative node package", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "create-snarknode-declarative-"));
    const result = await createSnarkNodePackage({
      name: "My Cool Node",
      executorType: "declarative",
      author: { name: "Test Author" },
      inputs: [{ id: "input", type: "text", required: false }],
      outputs: [{ id: "result", type: "json" }],
      params: []
    }, { outputDirectory });

    expect(result.outputPath.endsWith(join("", "my-cool-node.snarknode"))).toBe(true);
    const archive = await readFile(result.outputPath);
    const preview = await previewNodePackageArchive(archive);
    expect(preview.files.map((file) => file.path)).toContain("manifest.json");
    expect(preview.files.some((file) => file.path === "executor.ts")).toBe(false);
    expect(validateNodeManifest(preview.manifest).ok).toBe(true);
    expect(preview.manifest).toMatchObject({
      kind: "snarkroute.node",
      id: "custom.my-cool-node",
      author: { name: "Test Author" },
      permissions: {
        network: false,
        readFiles: false,
        writeOutputs: false,
        shell: false,
        env: []
      },
      executor: { type: "declarative" },
      inputs: [{ id: "input", type: "text", required: false }],
      outputs: [{ id: "result", type: "json" }],
      params: []
    });
    expect(Array.isArray(preview.manifest.inputs)).toBe(true);
    expect(Array.isArray(preview.manifest.outputs)).toBe(true);
    expect(Array.isArray(preview.manifest.params)).toBe(true);
    expect(Array.isArray(preview.manifest.permissions)).toBe(false);
    expect(Array.isArray(preview.manifest.author)).toBe(false);
  });

  it("creates an importable plugin node package with executor code", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "create-snarknode-plugin-"));
    const installedDirectory = await mkdtemp(join(tmpdir(), "create-snarknode-installed-"));
    const result = await createSnarkNodePackage({
      slug: "Plugin Echo",
      title: "Plugin Echo",
      author: "Test Author",
      category: "Debug",
      behavior: "Echoes inputs and params.",
      executorType: "plugin",
      permissions: { env: ["SNARKROUTE_TEST_TOKEN"] },
      inputs: [{ id: "message", type: "text", required: false }],
      outputs: [{ id: "result", type: "json", label: "Result" }],
      params: [{ id: "label", type: "text", default: "echo" }],
      includeExamples: true
    }, { outputDirectory });

    const archive = await readFile(result.outputPath);
    const preview = await previewNodePackageArchive(archive);
    expect(preview.files.map((file) => file.path)).toEqual(expect.arrayContaining(["manifest.json", "executor.ts", "README.md", "examples/example.route.json"]));
    expect(preview.manifest.executor).toMatchObject({ type: "plugin", runtime: "node", entry: "executor.ts" });
    expect(preview.manifest.permissions).toMatchObject({
      network: false,
      networkHosts: [],
      readFiles: false,
      writeOutputs: false,
      shell: false,
      env: ["SNARKROUTE_TEST_TOKEN"]
    });
    await installNodePackageFromArchive(archive, { installedDirectory, overwrite: true });
  });

  it("lets the installed standalone skill script create an importable package without the workspace generator", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "create-snarknode-standalone-"));
    const specPath = join(outputDirectory, "spec.json");
    await writeFile(specPath, JSON.stringify({
      name: "Standalone User Node",
      author: { name: "Test Author" },
      executorType: "plugin",
      inputs: [{ id: "text", type: "text", required: false }],
      outputs: [{ id: "result", type: "json" }],
      params: [],
      pluginCode: "export async function runNode(context) { return { outputs: { result: { text: context.inputs.text ?? null } } }; }\n"
    }), "utf8");

    await execFileAsync(process.execPath, [
      resolve("../../docs/snarkroute-node-builder/scripts/create-snarknode.mjs"),
      specPath,
      outputDirectory
    ]);

    const archive = await readFile(join(outputDirectory, "standalone-user-node.snarknode"));
    const preview = await previewNodePackageArchive(archive);
    expect(preview.manifest).toMatchObject({
      id: "custom.standalone-user-node",
      author: { name: "Test Author" },
      executor: { type: "plugin", runtime: "node", entry: "executor.ts" }
    });
    expect(preview.files.map((file) => file.path)).toEqual(expect.arrayContaining(["manifest.json", "executor.ts", "README.md"]));
  });
});
