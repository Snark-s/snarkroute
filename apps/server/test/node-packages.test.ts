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

  it("publishes validated portable tools and filters them by host", async () => {
    const app = await testServer();
    const manifest = {
      ...exampleManifest(), id: "example.portable.tool", title: "Portable Tool",
      inputs: [{ id: "image", type: "image", required: true }], outputs: [{ id: "image", type: "image" }],
      tool: {
        schemaVersion: "1.0", id: "example.portable.tool", title: "Portable Tool", version: "1.0.0",
        action: { kind: "node", value: "example.portable.tool" },
        inputs: [{ id: "image", type: "image", required: true, source: "host_selection", hostSources: { after_effects: "host_current_frame" }, acceptedMimes: ["image/*"] }],
        outputs: [{ id: "image", type: "image", required: true, placement: "new_artifact", hostPlacements: { after_effects: "replace_placeholder" } }],
        params: [{ id: "prompt", type: "multiline_text", required: false }],
        hosts: [
          { host: "boojumroute", sources: ["host_selection"], placements: ["new_artifact"] },
          { host: "after_effects", sources: ["host_current_frame"], placements: ["replace_placeholder"] }
        ],
        job: { states: ["queued", "generating", "completed", "failed", "cancelled"], cancellable: false, retryable: true, selectableResults: false }
      }
    };
    try {
      const install = await app.inject({ method: "POST", url: "/api/node-packages/install", payload: { filename: "portable.node.json", text: JSON.stringify(manifest) } });
      expect(install.statusCode, install.body).toBe(200);
      const list = await app.inject({ method: "GET", url: "/api/tools?host=after_effects" });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().tools).toEqual(expect.arrayContaining([expect.objectContaining({ source: "explicit", tool: expect.objectContaining({ id: "example.portable.tool" }) })]));
      expect(JSON.stringify(list.json())).not.toMatch(/apiKey|accessToken|password/);
      const one = await app.inject({ method: "GET", url: "/api/tools/example.portable.tool" });
      expect(one.json()).toMatchObject({ ok: true, source: "explicit", tool: { hosts: expect.arrayContaining([expect.objectContaining({ host: "after_effects" })]) } });
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

  it("separates one-input Living Canvas buttons from multi-input Brandeshmyg actions", async () => {
    const app = await testServer();
    const button = {
      ...exampleManifest(),
      id: "example.living-button",
      inputs: [{ id: "image", type: "image", label: "Image" }],
      outputs: [{ id: "image", type: "image", label: "Image" }],
      canvasAction: { enabled: true, surface: "livingCanvas", title: "Living button" }
    };
    const action = {
      ...exampleManifest(),
      id: "example.brand-action",
      inputs: [
        { id: "startImage", type: "image", label: "Start image" },
        { id: "endImage", type: "image", label: "End image" },
        { id: "prompt", type: "text", label: "Prompt" }
      ],
      outputs: [{ id: "video", type: "video", label: "Video" }],
      canvasAction: { enabled: true, surface: "brandeshmyg", title: "Brand action" }
    };
    try {
      for (const manifest of [button, action]) {
        const install = await app.inject({
          method: "POST",
          url: "/api/node-packages/install",
          payload: { filename: `${manifest.id}.node.json`, text: JSON.stringify(manifest) }
        });
        expect(install.statusCode, install.body).toBe(200);
      }

      const living = (await app.inject({ method: "GET", url: "/api/nodes/canvas-actions?surface=livingCanvas" })).json().actions;
      const brandeshmyg = (await app.inject({ method: "GET", url: "/api/nodes/canvas-actions?surface=brandeshmyg" })).json().actions;

      expect(living).toEqual(expect.arrayContaining([expect.objectContaining({ id: button.id })]));
      expect(living).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: action.id })]));
      expect(brandeshmyg).toEqual(expect.arrayContaining([expect.objectContaining({
        id: action.id,
        inputs: action.inputs.map((input) => ({ ...input, required: undefined }))
      })]));
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
