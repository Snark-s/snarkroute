import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createExecutor } from "@snarkroute/executor";
import {
  buildStableDiffusionHiddenControlPayload,
  builtInNodeManifests,
  encodeStableDiffusionControlImageBase64,
  findQrMonsterControlNetModel,
  installNodePackageFromManifest,
  installNodePackageFromArchive,
  loadInstalledNodeManifests,
  loadPromptLibrary,
  loadResourceLibrary,
  packNodePackage,
  parsePromptFile,
  parseResourceFile,
  previewNodePackageArchive,
  preflightStableDiffusionQrMonster,
  registerBuiltInNodeRunners,
  registerInstalledNodeRunners,
  uninstallInstalledNode,
  validateNodeLibraryManifest,
  validateNodeManifest,
  validatePromptLibraryNodes,
  validateRouteNodeTypes
} from "../src/index";

describe("built-in nodes", () => {
  it("exposes bundled nodes as manifest-style packages", () => {
    expect(builtInNodeManifests.length).toBeGreaterThan(0);
    expect(builtInNodeManifests.find((manifest) => manifest.id === "input.text")).toMatchObject({
      kind: "snarkroute.node",
      author: { name: "SnarkRoute maintainers" },
      origin: "bundled",
      source: "snarkroute-core",
      executor: { type: "builtin" }
    });
    expect(builtInNodeManifests.find((manifest) => manifest.id === "local.stableDiffusion.textToImage")?.capabilities).toEqual([
      { id: "image.create", title: "Create Image", priority: 10 }
    ]);
    expect(builtInNodeManifests.find((manifest) => manifest.id === "ai.image.sd15.qr_monster_hidden_control")).toMatchObject({
      title: "Double Image Illusion",
      category: "Local / Stable Diffusion",
      permissions: { network: true, networkHosts: ["127.0.0.1", "localhost"], readFiles: true, writeOutputs: true },
      inputs: [
        { id: "controlImage", type: "image", required: true, label: "Control Image", description: "Hidden picture, silhouette, pattern, or QR code passed to ControlNet." },
        { id: "prompt", type: "text", required: false, label: "Prompt" },
        { id: "negativePrompt", type: "text", required: false, label: "Negative Prompt" }
      ]
    });
    expect(builtInNodeManifests.find((manifest) => manifest.id === "capability.image.create")).toBeTruthy();
    expect(builtInNodeManifests.find((manifest) => manifest.id === "transform.panorama360ToFisheye")).toMatchObject({
      inputs: [{ id: "image", type: "image", required: true, label: "Image" }],
      outputs: [{ id: "image", type: "image", label: "Image" }]
    });
  });

  it("validates node manifests with required author and permissions", () => {
    const valid = validateNodeManifest(examplePluginManifest());
    expect(valid.ok).toBe(true);
    const invalid = validateNodeManifest({ ...examplePluginManifest(), author: {} });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.some((issue) => issue.path === "author.name")).toBe(true);
  });

  it("validates library manifests", () => {
    const validation = validateNodeLibraryManifest({
      kind: "snarkroute.nodeLibrary",
      schemaVersion: "0.1",
      id: "example.nodes",
      title: "Example Nodes",
      version: "0.1.0",
      author: { name: "Example Author" },
      license: "private",
      nodes: [{ id: "example.plugin.envEcho", title: "Env Echo", url: "https://example.com/env.snarknode", version: "0.1.0" }]
    });
    expect(validation.ok).toBe(true);
  });

  it("installs plugin nodes locally and filters env for executor code", async () => {
    const installedDirectory = await mkdtemp(join(tmpdir(), "sr-installed-nodes-"));
    const manifest = examplePluginManifest();
    await installNodePackageFromManifest(manifest, {
      installedDirectory,
      files: [{
        path: "executor.ts",
        text: `export async function runNode(context) {
  return { outputs: { envKeys: Object.keys(context.env), secret: context.env.SNARKROUTE_TEST_ALLOWED ?? null } };
}
`
      }]
    });
    const previousAllowed = process.env.SNARKROUTE_TEST_ALLOWED;
    const previousBlocked = process.env.SNARKROUTE_TEST_BLOCKED;
    process.env.SNARKROUTE_TEST_ALLOWED = "allowed";
    process.env.SNARKROUTE_TEST_BLOCKED = "blocked";
    try {
      const executor = createExecutor();
      await registerInstalledNodeRunners(executor, installedDirectory);
      const result = await executor.executeRoute(
        {
          routeVersion: "0.1",
          route: { id: "plugin-test", title: "Plugin Test", author: {} },
          economics: { enabled: false },
          nodes: [{ id: "plugin", type: manifest.id }],
          edges: []
        },
        { outputDirectory: await mkdtemp(join(tmpdir(), "sr-plugin-run-")) }
      );
      expect(result.status).toBe("succeeded");
      expect(result.nodeResults.plugin.output).toEqual({ envKeys: ["SNARKROUTE_TEST_ALLOWED"], secret: "allowed" });
      expect(JSON.stringify(result)).not.toContain("blocked");
    } finally {
      restoreEnv("SNARKROUTE_TEST_ALLOWED", previousAllowed);
      restoreEnv("SNARKROUTE_TEST_BLOCKED", previousBlocked);
    }
  });

  it("packs and installs a portable .snarknode archive with executor files", async () => {
    const sourceDirectory = await writePluginPackageFolder();
    const packed = await packNodePackage(sourceDirectory);
    expect(packed.outputPath.endsWith(".snarknode")).toBe(true);
    const archive = await readFile(packed.outputPath);
    const preview = await previewNodePackageArchive(archive);
    expect(preview.manifest).toMatchObject({ id: "example.plugin.envEcho", author: { name: "Test Author" } });
    expect(preview.files.some((file) => file.path === "executor.ts")).toBe(true);
    const installedDirectory = await mkdtemp(join(tmpdir(), "sr-installed-archive-"));
    await installNodePackageFromArchive(archive, { installedDirectory, overwrite: true });
    const manifests = await loadInstalledNodeManifests(installedDirectory);
    expect(manifests[0].id).toBe("example.plugin.envEcho");
  });

  it("rejects malicious archives with path traversal", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(examplePluginManifest()));
    zip.file("../evil.js", "throw new Error('nope');");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await expect(previewNodePackageArchive(bytes)).rejects.toThrow(/escape|unsupported|relative/i);
  });

  it("runs a declarative.http node without plugin code", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ result: { text: "declarative ok" } }));
    });
    const baseUrl = await listen(server);
    const installedDirectory = await mkdtemp(join(tmpdir(), "sr-declarative-http-"));
    try {
      await installNodePackageFromManifest(declarativeHttpManifest(baseUrl), { installedDirectory, overwrite: true });
      const executor = createExecutor();
      await registerInstalledNodeRunners(executor, installedDirectory);
      const result = await executor.executeRoute(
        {
          routeVersion: "0.1",
          route: { id: "declarative-http", title: "Declarative HTTP", author: {} },
          economics: { enabled: false },
          nodes: [{ id: "http", type: "example.http.declarative", params: { prompt: "hello" } }],
          edges: []
        },
        { outputDirectory: await mkdtemp(join(tmpdir(), "sr-declarative-run-")) }
      );
      expect(result.status).toBe("succeeded");
      expect(result.nodeResults.http.output).toEqual({ text: "declarative ok" });
    } finally {
      await closeServer(server);
    }
  });

  it("reports route nodes missing from the manifest catalog", async () => {
    const issues = await validateRouteNodeTypes([{ id: "missing", type: "example.missing" }], builtInNodeManifests);
    expect(issues[0].message).toContain("is not installed");
  });

  it("accepts capability route nodes when a provider declares support", async () => {
    const issues = await validateRouteNodeTypes([{ id: "make", type: "capability.image.create" }], builtInNodeManifests);
    expect(issues).toEqual([]);
  });

  it("loads installed node manifests", async () => {
    const installedDirectory = await mkdtemp(join(tmpdir(), "sr-installed-nodes-"));
    await installNodePackageFromManifest(examplePluginManifest(), { installedDirectory, files: [{ path: "executor.ts", text: "export async function runNode(){ return { outputs: {} }; }\n" }] });
    const manifests = await loadInstalledNodeManifests(installedDirectory);
    expect(manifests[0]).toMatchObject({ id: "example.plugin.envEcho", origin: "installed" });
  });

  it("runs generated compound node packages", async () => {
    const installedDirectory = await mkdtemp(join(tmpdir(), "sr-generated-nodes-"));
    await installNodePackageFromManifest(
      {
        kind: "snarkroute.node",
        schemaVersion: "0.1",
        id: "generated.echoPair",
        title: "Echo Pair",
        version: "0.1.0",
        author: { name: "Test Author" },
        license: "UNLICENSED",
        origin: "generated",
        permissions: { network: false, readFiles: false, writeOutputs: false, shell: false, env: [] },
        executor: { type: "declarative" },
        inputs: [{ id: "text", type: "text" }],
        outputs: [{ id: "left", type: "json" }, { id: "right", type: "json" }],
        generatedWith: {
          kind: "compound.subroute",
          compound: {
            inputs: [{ id: "text", nodeId: "left", port: "input", targets: [{ nodeId: "left", port: "input" }, { nodeId: "right", port: "input" }] }],
            outputs: [{ id: "left", nodeId: "left", port: "output" }, { id: "right", nodeId: "right", port: "output" }]
          },
          subroute: {
            routeVersion: "0.1",
            route: { id: "sub", title: "Sub", author: {} },
            economics: { enabled: false },
            nodes: [{ id: "left", type: "utility.null" }, { id: "right", type: "utility.null" }],
            edges: []
          }
        }
      },
      { installedDirectory }
    );
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);
    await registerInstalledNodeRunners(executor, installedDirectory);
    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "r", title: "R", author: {} },
        economics: { enabled: false },
        nodes: [
          { id: "source", type: "input.text", params: { value: "hello" } },
          { id: "pair", type: "generated.echoPair" }
        ],
        edges: [{ from: "source", to: "pair", fromPort: "text", toPort: "text" }]
      },
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-run-")) }
    );
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.pair.output).toEqual({ left: "hello", right: "hello" });
  });

  it("uninstalls local node packages from the installed directory", async () => {
    const installedDirectory = await mkdtemp(join(tmpdir(), "sr-installed-delete-"));
    await installNodePackageFromManifest(examplePluginManifest(), { installedDirectory, files: [{ path: "executor.ts", text: "export async function runNode(){ return { outputs: {} }; }\n" }] });

    await uninstallInstalledNode("example.plugin.envEcho", installedDirectory);

    expect(await loadInstalledNodeManifests(installedDirectory)).toEqual([]);
  });

  it("refuses to uninstall bundled node packages", async () => {
    const installedDirectory = await mkdtemp(join(tmpdir(), "sr-installed-bundled-delete-"));
    const bundled = { ...examplePluginManifest(), origin: "bundled" as const };
    await installNodePackageFromManifest(bundled, { installedDirectory, origin: "bundled", files: [{ path: "executor.ts", text: "export async function runNode(){ return { outputs: {} }; }\n" }] });

    await expect(uninstallInstalledNode("example.plugin.envEcho", installedDirectory)).rejects.toThrow("Bundled node");
    expect((await loadInstalledNodeManifests(installedDirectory))[0]).toMatchObject({ id: "example.plugin.envEcho", origin: "bundled" });
  });

  it("keeps routes intact and reports missing nodes after uninstall", async () => {
    const installedDirectory = await mkdtemp(join(tmpdir(), "sr-installed-route-delete-"));
    await installNodePackageFromManifest(examplePluginManifest(), { installedDirectory, files: [{ path: "executor.ts", text: "export async function runNode(){ return { outputs: {} }; }\n" }] });
    const routeNodes = [{ id: "plugin", type: "example.plugin.envEcho", params: { value: "preserved" } }];

    await uninstallInstalledNode("example.plugin.envEcho", installedDirectory);

    expect(routeNodes).toEqual([{ id: "plugin", type: "example.plugin.envEcho", params: { value: "preserved" } }]);
    const issues = await validateRouteNodeTypes(routeNodes, [...builtInNodeManifests, ...(await loadInstalledNodeManifests(installedDirectory))]);
    expect(issues[0].message).toContain("is not installed");
  });

  it("scans data/prompt-library style .prompt.md files", async () => {
    const libraryPath = await writePromptLibrary();
    const library = await loadPromptLibrary(libraryPath);
    expect(library.categories[0].id).toBe("image-generation");
    expect(library.categories[0].prompts[0]).toMatchObject({ id: "demo", title: "Demo", text: "A reusable image prompt.", ref: "image-generation/demo" });
  });

  it("scans data/resource-library style .resource.md files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-resource-library-data-"));
    await writeResourceFile(directory, "characters/hero.resource.md", "character", "hero", "Hero", "brave explorer");
    const library = await loadResourceLibrary(directory);
    expect(library.resources[0]).toMatchObject({ id: "hero", kind: "character", title: "Hero", ref: "character/hero", prompt: "brave explorer" });
  });

  it("parses resource frontmatter and markdown body", () => {
    const parsed = parseResourceFile(`---
id: studio
kind: location
title: Studio
tags:
  - indoor
---

soft daylight loft
`);
    expect("resource" in parsed ? parsed.resource : null).toMatchObject({
      id: "studio",
      kind: "location",
      title: "Studio",
      tags: ["indoor"],
      prompt: "soft daylight loft"
    });
  });

  it("character capability can resolve a linked resource", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-resource-library-data-"));
    await writeResourceFile(directory, "characters/hero.resource.md", "character", "hero", "Hero", "brave explorer");
    const previous = process.env.SNARKROUTE_RESOURCE_LIBRARY_PATH;
    process.env.SNARKROUTE_RESOURCE_LIBRARY_PATH = directory;
    try {
      const result = await executeRoute({
        nodes: [{ id: "character", type: "capability.character.create", params: { resource: "character/hero" } }],
        edges: []
      });
      expect(result.status).toBe("succeeded");
      expect(result.nodeResults.character.output).toMatchObject({ resource: { ref: "character/hero", prompt: "brave explorer" } });
    } finally {
      restoreResourceLibraryPath(previous);
    }
  });

  it("parses prompt frontmatter and markdown body", () => {
    const parsed = parsePromptFile(`---
id: demo
title: Demo
category: image-generation
description: Demo description
tags:
  - demo
kind: system
---

A reusable image prompt.
`);
    expect("prompt" in parsed ? parsed.prompt : null).toMatchObject({
      id: "demo",
      title: "Demo",
      category: "image-generation",
      description: "Demo description",
      tags: ["demo"],
      kind: "system",
      text: "A reusable image prompt."
    });
  });

  it("library.prompt resolves linked prompt text", async () => {
    const libraryPath = await writePromptLibrary();
    const previous = process.env.SNARKROUTE_PROMPT_LIBRARY_PATH;
    process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = libraryPath;
    try {
      const result = await executeRoute({
        nodes: [{ id: "prompt", type: "library.prompt", params: { category: "image-generation", promptId: "demo", mode: "linked" } }],
        edges: []
      });
      expect(result.status).toBe("succeeded");
      expect(result.nodeResults.prompt.output).toEqual({ text: "A reusable image prompt." });
    } finally {
      restorePromptLibraryPath(previous);
    }
  });

  it("library.prompt resolves embedded prompt text", async () => {
    const result = await executeRoute({
      nodes: [{ id: "prompt", type: "library.prompt", params: { category: "custom", promptId: "copy", mode: "embedded", embeddedText: "Local embedded text." } }],
      edges: []
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.prompt.output).toEqual({ text: "Local embedded text." });
  });

  it("library.prompt fails clearly for a missing linked prompt", async () => {
    const libraryPath = await writePromptLibrary();
    const previous = process.env.SNARKROUTE_PROMPT_LIBRARY_PATH;
    process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = libraryPath;
    try {
      const result = await executeRoute({
        nodes: [{ id: "prompt", type: "library.prompt", params: { category: "image-generation", promptId: "missing", mode: "linked" } }],
        edges: []
      });
      expect(result.status).toBe("failed");
      expect(result.nodeResults.prompt.error).toContain('Linked prompt "image-generation/missing" was not found');
    } finally {
      restorePromptLibraryPath(previous);
    }
  });

  it("validates missing linked prompts clearly", async () => {
    const issues = await validatePromptLibraryNodes(
      [{ id: "prompt", type: "library.prompt", params: { category: "image-generation", promptId: "missing", mode: "linked" } }],
      await writePromptLibrary()
    );
    expect(issues).toEqual([
      {
        path: "nodes.prompt.params",
        message: 'Linked prompt "image-generation/missing" was not found in the local prompt library.'
      }
    ]);
  });

  it("reports invalid prompt frontmatter without crashing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-prompt-library-data-"));
    await writeFile(join(directory, "broken.prompt.md"), "---\nid: broken\n---\n\nBody", "utf8");
    const library = await loadPromptLibrary(directory);
    expect(library.categories).toEqual([]);
    expect(library.diagnostics[0].message).toContain("requires string fields");
  });

  it("handles duplicate prompt refs without crashing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-prompt-library-data-"));
    await writePromptFile(directory, "one.prompt.md", "image-generation", "demo", "First");
    await writePromptFile(directory, "two.prompt.md", "image-generation", "demo", "Second");
    const library = await loadPromptLibrary(directory);
    expect(library.categories[0].prompts[0].text).toBe("First");
    expect(library.diagnostics.some((entry) => entry.message.includes("Duplicate prompt ref"))).toBe(true);
  });


  it("library.prompt output text can be referenced by a template node", async () => {
    const libraryPath = await writePromptLibrary();
    const previous = process.env.SNARKROUTE_PROMPT_LIBRARY_PATH;
    process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = libraryPath;
    try {
      const result = await executeRoute({
        nodes: [
          { id: "prompt", type: "library.prompt", params: { category: "image-generation", promptId: "demo", mode: "linked" } },
          { id: "template", type: "transform.template", params: { template: "{{prompt.output.text}} Use warm light." } }
        ],
        edges: [{ from: "prompt", to: "template" }]
      });
      expect(result.status).toBe("succeeded");
      expect(result.nodeResults.template.output).toEqual({ text: "A reusable image prompt. Use warm light." });
    } finally {
      restorePromptLibraryPath(previous);
    }
  });

  it("text.promptCompose joins two texts in plain mode", async () => {
    const result = await executeRoute({
      nodes: [
        { id: "first", type: "input.text", params: { value: "Draw a black cat" } },
        { id: "second", type: "input.text", params: { value: "Organic Art Nouveau style" } },
        { id: "compose", type: "text.promptCompose", params: { mode: "plain", separator: "\n\n" } }
      ],
      edges: [
        { from: "first", to: "compose", fromPort: "text", toPort: "texts" },
        { from: "second", to: "compose", fromPort: "text", toPort: "texts" }
      ]
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compose.output).toEqual({ text: "Draw a black cat\n\nOrganic Art Nouveau style" });
  });

  it("text.promptCompose skips empty parts by default", async () => {
    const result = await executeRoute({
      nodes: [{ id: "compose", type: "text.promptCompose", params: { text1: "First", text2: "", text3: "Third", separator: "|" } }],
      edges: []
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compose.output).toEqual({ text: "First|Third" });
  });

  it("text.promptCompose includes manual prompt text before other parts", async () => {
    const result = await executeRoute({
      nodes: [{ id: "compose", type: "text.promptCompose", params: { manualText: "Manual", text1: "Connected-ish", separator: " | " } }],
      edges: []
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compose.output).toEqual({ text: "Manual | Connected-ish" });
  });

  it("text.promptCompose trims parts by default", async () => {
    const result = await executeRoute({
      nodes: [{ id: "compose", type: "text.promptCompose", params: { text1: "  First\n", text2: "\nSecond  ", separator: " " } }],
      edges: []
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compose.output).toEqual({ text: "First Second" });
  });

  it("text.promptCompose adds prefix and suffix", async () => {
    const result = await executeRoute({
      nodes: [{ id: "compose", type: "text.promptCompose", params: { text1: "core prompt", prefix: "[", suffix: "]" } }],
      edges: []
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compose.output).toEqual({ text: "[core prompt]" });
  });

  it("text.promptCompose keeps legacy param parts plain", async () => {
    const result = await executeRoute({
      nodes: [{ id: "compose", type: "text.promptCompose", params: { text1: "Subject", text2: "Style", separator: "\n\n" } }],
      edges: []
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compose.output).toEqual({ text: "Subject\n\nStyle" });
  });

  it("text.promptCompose always labels connected named input slots", async () => {
    const result = await executeRoute({
      nodes: [
        { id: "subjectA", type: "input.text", params: { value: "black cat" } },
        { id: "subjectB", type: "input.text", params: { value: "green eyes" } },
        { id: "style", type: "input.text", params: { value: "Art Nouveau" } },
        {
          id: "compose",
          type: "text.promptCompose",
          params: {
            separator: "\n\n"
          }
        }
      ],
      edges: [
        { from: "subjectA", to: "compose", fromPort: "text", toPort: "subject" },
        { from: "subjectB", to: "compose", fromPort: "text", toPort: "subject" },
        { from: "style", to: "compose", fromPort: "text", toPort: "style" }
      ]
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compose.output).toEqual({ text: "Subject:\nblack cat\n\nSubject 2:\ngreen eyes\n\nStyle:\nArt Nouveau" });
  });

  it("text.promptCompose stringifies non-string values", async () => {
    const result = await executeRoute({
      nodes: [{ id: "compose", type: "text.promptCompose", params: { text1: 42, text2: true, separator: ", " } }],
      edges: []
    });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compose.output).toEqual({ text: "42, true" });
  });

  it("output.text displays input without writing a file", async () => {
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);
    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "text-output-test", title: "Text Output Test", author: {} },
        economics: { enabled: false },
        nodes: [
          { id: "input", type: "input.text", params: { value: "hello text" } },
          { id: "output", type: "output.text" }
        ],
        edges: [{ from: "input", to: "output", fromPort: "text", toPort: "from" }]
      },
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-text-output-")) }
    );

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.output.output).toEqual({ text: "hello text" });
  });

  it("utility.null accepts any input and passes it through", async () => {
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);
    const manifest = builtInNodeManifests.find((entry) => entry.id === "utility.null");
    expect(manifest?.inputs).toEqual([{ id: "input", type: "data", required: false, label: "Any" }]);
    expect(manifest?.outputs).toEqual([{ id: "output", type: "data", label: "Output" }]);

    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "null-test", title: "Null Test", author: {} },
        economics: { enabled: false },
        nodes: [
          { id: "input", type: "input.text", params: { value: "ignored" } },
          { id: "null", type: "utility.null" }
        ],
        edges: [{ from: "input", to: "null", fromPort: "text", toPort: "input" }]
      },
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-null-")) }
    );

    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.null.output).toBe("ignored");
  });

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

  it("preview.image accepts local image object", async () => {
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);
    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "preview-test", title: "Preview Test", author: {} },
        economics: { enabled: false },
        nodes: [{ id: "preview", type: "preview.image", params: { image: { localPath: "C:\\image.png", mimeType: "image/png" } } }],
        edges: []
      },
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-preview-")) }
    );
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.preview.output).toMatchObject({ image: { localPath: "C:\\image.png" } });
  });

  it("preview.image accepts remote URL", async () => {
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);
    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "preview-test", title: "Preview Test", author: {} },
        economics: { enabled: false },
        nodes: [{ id: "preview", type: "preview.image", params: { image: "https://example.com/out.webp" } }],
        edges: []
      },
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-preview-")) }
    );
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.preview.output).toMatchObject({ image: { originalUrl: "https://example.com/out.webp" } });
  });

  it("preview.image rejects non-image input clearly", async () => {
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);
    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "preview-test", title: "Preview Test", author: {} },
        economics: { enabled: false },
        nodes: [{ id: "preview", type: "preview.image", params: { image: "not-image.txt" } }],
        edges: []
      },
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-preview-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.nodeResults.preview.error).toContain("expected an image");
  });

  it("projects a local equirectangular panorama PNG to fisheye with a configurable angle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-panorama-fisheye-"));
    const panoramaPath = join(directory, "panorama.png");
    await writeFile(panoramaPath, testRgbaPng(4, 2));

    const result = await executeRoute({
      nodes: [{ id: "fisheye", type: "transform.panorama360ToFisheye", params: { image: panoramaPath, fovDegrees: 220, yawDegrees: 15 } }],
      edges: []
    });

    expect(result.status).toBe("succeeded");
    const output = result.nodeResults.fisheye.output as { image?: { localPath?: string; width?: number; height?: number }; metadata?: { fovDegrees?: number; outputSize?: number } };
    expect(output.image).toMatchObject({ width: 2, height: 2 });
    expect(output.metadata).toMatchObject({ fovDegrees: 220, outputSize: 2, pitchDegrees: -90 });
    expect((await readFile(output.image!.localPath!)).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("http.request calls JSON endpoints through the runner", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, url: request.url }));
    });
    const baseUrl = await listen(server);
    try {
      const result = await executeRoute({
        nodes: [{ id: "http", type: "http.request", params: { url: `${baseUrl}/demo`, method: "GET", query: { q: "snark" }, responseMode: "json" } }],
        edges: []
      });
      expect(result.status).toBe("succeeded");
      expect(result.nodeResults.http.output).toMatchObject({ status: 200, responseJson: { ok: true, url: "/demo?q=snark" } });
    } finally {
      await closeServer(server);
    }
  });

  it("local Stable Diffusion txt2img stores returned base64 image", async () => {
    let requestBody = "";
    const server = createServer((request, response) => {
      if (request.url !== "/sdapi/v1/txt2img") {
        response.statusCode = 404;
        response.end("missing");
        return;
      }
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ images: [tinyPng().toString("base64")], info: JSON.stringify({ seed: 42 }) }));
      });
    });
    const endpoint = await listen(server);
    try {
      const result = await executeRoute({
        nodes: [{ id: "sd", type: "local.stableDiffusion.textToImage", params: { endpoint, model: "demo-model.safetensors", prompt: "test", width: 1, height: 1, steps: 1, cfgScale: 1, batchSize: 1 } }],
        edges: []
      });
      expect(result.status).toBe("succeeded");
      const output = result.nodeResults.sd.output as { image?: { localPath?: string }; metadata?: { localBackend?: string; seed?: number } };
      expect(output.metadata).toMatchObject({ localBackend: "stable-diffusion-webui-compatible", seed: 42, model: "demo-model.safetensors" });
      expect(JSON.parse(requestBody).override_settings).toEqual({ sd_model_checkpoint: "demo-model.safetensors" });
      expect(await readFile(output.image!.localPath!)).toEqual(tinyPng());
    } finally {
      await closeServer(server);
    }
  });

  it("finds QR Code Monster ControlNet models by supported substrings", () => {
    expect(findQrMonsterControlNetModel({ model_list: ["control_v1p_sd15_qrcode_monster [a1b2]", "other"] })).toBe("control_v1p_sd15_qrcode_monster [a1b2]");
    expect(findQrMonsterControlNetModel({ model_list: ["diffusion_pytorch_model", "my-qrcode_monster-v2"] })).toBe("my-qrcode_monster-v2");
    expect(findQrMonsterControlNetModel({ model_list: ["tile", "canny"] })).toBeNull();
  });

  it("builds a ControlNet QR Monster txt2img payload with base64 PNG control image", async () => {
    const payload = await buildStableDiffusionHiddenControlPayload(
      {
        controlImage: `data:image/png;base64,${testRgbaPng(2, 2).toString("base64")}`,
        prompt: "ornate poster",
        negativePrompt: "blur",
        width: 4,
        height: 4,
        steps: 12,
        cfgScale: 6,
        samplerName: "Euler a",
        seed: 123,
        batchSize: 2,
        controlWeight: 1.4,
        guidanceStart: 0.1,
        guidanceEnd: 0.9,
        controlMode: "ControlNet is more important",
        resizeMode: "Scale to Fit (Inner Fit)",
        pixelPerfect: false,
        preprocessThreshold: 128
      },
      {},
      "control_v1p_sd15_qrcode_monster [abc]"
    );

    expect(payload).toMatchObject({
      prompt: "ornate poster",
      negative_prompt: "blur",
      width: 4,
      height: 4,
      steps: 12,
      cfg_scale: 6,
      sampler_name: "Euler a",
      seed: 123,
      batch_size: 2
    });
    expect(payload.alwayson_scripts.controlnet.args[0]).toMatchObject({
      enabled: true,
      module: "none",
      model: "control_v1p_sd15_qrcode_monster [abc]",
      weight: 1.4,
      resize_mode: "Scale to Fit (Inner Fit)",
      guidance_start: 0.1,
      guidance_end: 0.9,
      control_mode: "ControlNet is more important",
      pixel_perfect: false
    });
    expect(Buffer.from(payload.alwayson_scripts.controlnet.args[0].image, "base64").subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("preflights Automatic1111 ControlNet and reports missing QR Monster model clearly", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/controlnet/version") response.end(JSON.stringify({ version: "1.1" }));
      else if (request.url === "/controlnet/model_list") response.end(JSON.stringify({ model_list: ["control_v11p_sd15_canny"] }));
      else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    const endpoint = await listen(server);
    try {
      await expect(preflightStableDiffusionQrMonster(endpoint)).rejects.toThrow("QR Code Monster model is not installed");
    } finally {
      await closeServer(server);
    }
  });

  it("encodes preprocessed control images as plain base64 PNG", () => {
    const base64 = encodeStableDiffusionControlImageBase64({
      width: 1,
      height: 1,
      data: new Uint8Array([10, 20, 30, 255])
    }, { width: 2, height: 2, grayscale: true, invert: true, threshold: 16 });
    expect(base64.startsWith("data:")).toBe(false);
    expect(Buffer.from(base64, "base64").subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("runs Stable Diffusion Hidden Control Image against a mocked A1111 API", async () => {
    let txt2imgBody = "";
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/controlnet/version") {
        response.end(JSON.stringify({ version: "1.1" }));
        return;
      }
      if (request.url === "/controlnet/model_list") {
        response.end(JSON.stringify({ model_list: ["control_v1p_sd15_qrcode_monster [abc]"] }));
        return;
      }
      if (request.url !== "/sdapi/v1/txt2img") {
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      request.on("data", (chunk) => {
        txt2imgBody += chunk;
      });
      request.on("end", () => {
        response.end(JSON.stringify({ images: [tinyPng().toString("base64")], info: JSON.stringify({ seed: 77 }) }));
      });
    });
    const endpoint = await listen(server);
    try {
      const result = await executeRoute({
        nodes: [{
          id: "hidden",
          type: "ai.image.sd15.qr_monster_hidden_control",
          params: {
            endpoint,
            controlImage: `data:image/png;base64,${testRgbaPng(1, 1).toString("base64")}`,
            prompt: "ceramic tile",
            width: 1,
            height: 1,
            steps: 1,
            cfgScale: 1
          }
        }],
        edges: []
      });

      expect(result.status).toBe("succeeded");
      const output = result.nodeResults.hidden.output as { controlNetModel?: string; seed?: number; image?: { localPath?: string } };
      expect(output.controlNetModel).toBe("control_v1p_sd15_qrcode_monster [abc]");
      expect(output.seed).toBe(77);
      expect(JSON.parse(txt2imgBody).alwayson_scripts.controlnet.args[0]).toMatchObject({
        model: "control_v1p_sd15_qrcode_monster [abc]",
        module: "none",
        enabled: true
      });
      expect(await readFile(output.image!.localPath!)).toEqual(tinyPng());
    } finally {
      await closeServer(server);
    }
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

async function executeRoute(routePart: { nodes: Array<{ id: string; type: string; params?: Record<string, unknown> }>; edges: Array<{ from: string; to: string; fromPort?: string; toPort?: string }> }) {
  const executor = createExecutor();
  registerBuiltInNodeRunners(executor);
  return executor.executeRoute(
    {
      routeVersion: "0.1",
      route: { id: "prompt-library-test", title: "Prompt Library Test", author: {} },
      economics: { enabled: false },
      nodes: routePart.nodes,
      edges: routePart.edges
    },
    { outputDirectory: await mkdtemp(join(tmpdir(), "sr-prompt-library-")) }
  );
}

async function writePromptLibrary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sr-prompt-library-data-"));
  await writePromptFile(directory, "image-generation/demo.prompt.md", "image-generation", "demo", "A reusable image prompt.");
  return directory;
}

async function writePromptFile(directory: string, filename: string, category: string, id: string, body: string): Promise<void> {
  const path = join(directory, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `---\nid: ${id}\ntitle: ${id === "demo" ? "Demo" : id}\ncategory: ${category}\n---\n\n${body}\n`,
    "utf8"
  );
}

async function writeResourceFile(directory: string, filename: string, kind: string, id: string, title: string, body: string): Promise<void> {
  const path = join(directory, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nid: ${id}\nkind: ${kind}\ntitle: ${title}\n---\n\n${body}\n`, "utf8");
}

function restorePromptLibraryPath(previous: string | undefined): void {
  if (previous === undefined) delete process.env.SNARKROUTE_PROMPT_LIBRARY_PATH;
  else process.env.SNARKROUTE_PROMPT_LIBRARY_PATH = previous;
}

function restoreResourceLibraryPath(previous: string | undefined): void {
  if (previous === undefined) delete process.env.SNARKROUTE_RESOURCE_LIBRARY_PATH;
  else process.env.SNARKROUTE_RESOURCE_LIBRARY_PATH = previous;
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

function examplePluginManifest() {
  return {
    kind: "snarkroute.node",
    schemaVersion: "0.1",
    id: "example.plugin.envEcho",
    title: "Example Plugin Env Echo",
    version: "0.1.0",
    author: { name: "Test Author" },
    origin: "local",
    source: "test",
    license: "private",
    permissions: {
      network: false,
      networkHosts: [],
      readFiles: false,
      writeOutputs: false,
      shell: false,
      env: ["SNARKROUTE_TEST_ALLOWED"]
    },
    executor: {
      type: "plugin",
      runtime: "node",
      entry: "executor.ts"
    },
    inputs: [],
    outputs: [{ id: "envKeys", type: "json", label: "Env Keys" }]
  };
}

async function writePluginPackageFolder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sr-plugin-package-"));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(examplePluginManifest(), null, 2), "utf8");
  await writeFile(join(directory, "executor.ts"), "export async function runNode(){ return { outputs: { ok: true } }; }\n", "utf8");
  await mkdir(join(directory, "examples"));
  await writeFile(join(directory, "examples", "example.route.json"), JSON.stringify({ routeVersion: "0.1", route: { id: "example", title: "Example", author: { name: "Test Author" } }, nodes: [], edges: [] }, null, 2), "utf8");
  await writeFile(join(directory, ".env"), "SECRET=do-not-pack", "utf8");
  return directory;
}

function declarativeHttpManifest(baseUrl: string) {
  return {
    kind: "snarkroute.node",
    schemaVersion: "0.1",
    id: "example.http.declarative",
    title: "Example Declarative HTTP",
    version: "0.1.0",
    author: { name: "Test Author" },
    origin: "local",
    source: "test",
    license: "private",
    permissions: {
      network: true,
      networkHosts: ["127.0.0.1"],
      readFiles: false,
      writeOutputs: false,
      shell: false,
      env: []
    },
    executor: {
      type: "declarative.http",
      method: "POST",
      urlTemplate: `${baseUrl}/echo`,
      headersTemplate: { "Content-Type": "application/json" },
      bodyMode: "json",
      bodyTemplate: { prompt: "{{params.prompt}}" },
      response: {
        mode: "json",
        mappings: {
          text: "$.result.text"
        }
      }
    },
    inputs: [],
    outputs: [{ id: "text", type: "text", label: "Text" }],
    params: [{ id: "prompt", type: "text", label: "Prompt", default: "" }]
  };
}

function tinyPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  );
}

function testRgbaPng(width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const index = rowStart + 1 + x * 4;
      raw[index] = x * 50;
      raw[index + 1] = y * 100;
      raw[index + 2] = 200;
      raw[index + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    testPngChunk("IHDR", header),
    testPngChunk("IDAT", deflateSync(raw)),
    testPngChunk("IEND", Buffer.alloc(0))
  ]);
}

function testPngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(testCrc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function testCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Could not bind test server."));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
