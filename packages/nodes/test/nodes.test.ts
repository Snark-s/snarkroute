import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutor } from "@snarkroute/executor";
import {
  builtInNodeManifests,
  installNodePackageFromManifest,
  installNodePackageFromArchive,
  loadInstalledNodeManifests,
  loadPromptLibrary,
  loadResourceLibrary,
  packNodePackage,
  parsePromptFile,
  parseResourceFile,
  previewNodePackageArchive,
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
    expect(builtInNodeManifests.find((manifest) => manifest.id === "capability.image.create")).toBeTruthy();
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
