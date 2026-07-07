import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packNodePackage } from "@snarkroute/nodes";

const previousNoListen = process.env.SNARKROUTE_NO_LISTEN;
const previousInstalledNodesPath = process.env.SNARKROUTE_INSTALLED_NODES_PATH;
const previousCanvasActionsPath = process.env.SNARKROUTE_CANVAS_ACTIONS_PATH;

describe("node package upload API", () => {
  beforeEach(async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    process.env.SNARKROUTE_INSTALLED_NODES_PATH = await mkdtemp(join(tmpdir(), "sr-node-upload-api-"));
    process.env.SNARKROUTE_CANVAS_ACTIONS_PATH = await mkdtemp(join(tmpdir(), "sr-canvas-action-api-"));
  });

  afterEach(() => {
    restoreEnv("SNARKROUTE_NO_LISTEN", previousNoListen);
    restoreEnv("SNARKROUTE_INSTALLED_NODES_PATH", previousInstalledNodesPath);
    restoreEnv("SNARKROUTE_CANVAS_ACTIONS_PATH", previousCanvasActionsPath);
  });

  it("previews valid .node.json manifests", async () => {
    const app = await testServer();
    const text = JSON.stringify(exampleManifest());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/node-packages/preview",
        payload: { filename: "test-prompt.node.json", text: "", dataBase64: Buffer.from(text, "utf8").toString("base64") }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, manifest: { id: "example.upload.prompt", title: "Upload Prompt" } });
    } finally {
      await app.close();
    }
  });

  it("returns useful errors for invalid .node.json uploads", async () => {
    const app = await testServer();
    try {
      const invalidJson = await app.inject({
        method: "POST",
        url: "/api/node-packages/preview",
        payload: { filename: "broken.node.json", text: "{ nope" }
      });
      expect(invalidJson.statusCode).toBe(400);
      expect(invalidJson.json().issues[0].message).toBe("Invalid JSON node manifest.");

      const schemaInvalid = await app.inject({
        method: "POST",
        url: "/api/node-packages/preview",
        payload: { filename: "schema.node.json", text: JSON.stringify({ ...exampleManifest(), kind: "not-a-node" }) }
      });
      expect(schemaInvalid.statusCode).toBe(200);
      expect(schemaInvalid.json().issues).toContainEqual({ path: "kind", message: 'kind must be "snarkroute.node".' });
    } finally {
      await app.close();
    }
  });

  it("previews valid .snarknode ZIP packages", async () => {
    const app = await testServer();
    const sourceDirectory = await mkdtemp(join(tmpdir(), "sr-node-upload-package-"));
    await writeFile(join(sourceDirectory, "manifest.json"), JSON.stringify(exampleManifest()), "utf8");
    const packed = await packNodePackage(sourceDirectory);
    const dataBase64 = (await readFile(packed.outputPath)).toString("base64");
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/node-packages/preview",
        payload: { filename: "upload.snarknode", dataBase64 }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, manifest: { id: "example.upload.prompt" } });
    } finally {
      await app.close();
    }
  });

  it("returns a package-format error when .snarknode contains plain JSON", async () => {
    const app = await testServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/node-packages/preview",
        payload: { filename: "plain.snarknode", dataBase64: Buffer.from(JSON.stringify(exampleManifest()), "utf8").toString("base64") }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().issues[0].message).toBe("Invalid .snarknode package: expected a ZIP archive. For a plain node manifest, use .node.json.");
    } finally {
      await app.close();
    }
  });

  it("returns a useful error for unsupported extensions", async () => {
    const app = await testServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/node-packages/preview",
        payload: { filename: "node.txt", text: JSON.stringify(exampleManifest()) }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().issues[0].message).toContain("Unsupported node package file type");
    } finally {
      await app.close();
    }
  });

  it("deletes locally installed node packages and refreshes the installed list", async () => {
    const app = await testServer();
    try {
      const install = await app.inject({
        method: "POST",
        url: "/api/node-packages/install",
        payload: { filename: "delete-me.node.json", text: JSON.stringify(exampleManifest()) }
      });
      expect(install.statusCode).toBe(200);

      const response = await app.inject({
        method: "DELETE",
        url: "/api/node-packages/example.upload.prompt"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, id: "example.upload.prompt" });
      expect(await readdir(process.env.SNARKROUTE_INSTALLED_NODES_PATH!)).toEqual([]);

      const installed = await app.inject({ method: "GET", url: "/api/node-packages/installed" });
      expect(installed.json().nodes).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("deletes a canvas action from both the toolbar and installed package stores", async () => {
    const app = await testServer();
    const manifest = {
      ...exampleManifest(),
      id: "example.canvas.action",
      inputs: [{ id: "image", type: "image" }],
      outputs: [{ id: "image", type: "image" }],
      canvasAction: { enabled: true, title: "Canvas action" }
    };
    try {
      const install = await app.inject({
        method: "POST",
        url: "/api/node-packages/install",
        payload: { filename: "canvas-action.node.json", text: JSON.stringify(manifest) }
      });
      expect(install.statusCode, install.body).toBe(200);

      const response = await app.inject({ method: "DELETE", url: "/api/canvas-actions/example.canvas.action" });

      expect(response.statusCode, response.body).toBe(200);
      expect(await readdir(process.env.SNARKROUTE_INSTALLED_NODES_PATH!)).toEqual([]);
      expect(await readdir(process.env.SNARKROUTE_CANVAS_ACTIONS_PATH!)).toEqual([]);
      const actions = await app.inject({ method: "GET", url: "/api/nodes/canvas-actions" });
      expect(actions.json().actions).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "example.canvas.action" })]));
    } finally {
      await app.close();
    }
  });

  it("does not delete bundled nodes", async () => {
    const app = await testServer();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/node-packages/input.text"
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ ok: false, code: "NODE_PACKAGE_NOT_UNINSTALLABLE" });
      expect(response.json().error).toContain("Bundled node");
    } finally {
      await app.close();
    }
  });

  it("returns a useful error when deleting a missing node package", async () => {
    const app = await testServer();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/node-packages/example.missing"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ ok: false, code: "NODE_PACKAGE_NOT_FOUND" });
      expect(response.json().error).toContain("was not found");
    } finally {
      await app.close();
    }
  });
});

async function testServer() {
  const { buildServer } = await import("../src/index");
  return buildServer();
}

function exampleManifest() {
  return {
    kind: "snarkroute.node",
    schemaVersion: "0.1",
    id: "example.upload.prompt",
    title: "Upload Prompt",
    version: "0.1.0",
    author: { name: "Test Author" },
    license: "private",
    origin: "local",
    permissions: { network: false, readFiles: false, writeOutputs: false, shell: false, env: [] },
    executor: { type: "declarative" },
    inputs: [{ id: "input", type: "text" }],
    outputs: [{ id: "output", type: "text" }]
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
