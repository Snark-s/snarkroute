import { describe, expect, it } from "vitest";
import {
  NODE_PACKAGE_INSTALL_PATH,
  NODE_PACKAGE_PREVIEW_PATH,
  canImportNodePackageFilename,
  canUninstallNodePackage,
  nodePackageIsUsedInRoute,
  readNodePackageFilePayload,
  uninstallNodeConfirmationMessage
} from "./nodePackageImport";

describe("node package import helpers", () => {
  it("keeps Import Node File on the preview/install API path", () => {
    expect(NODE_PACKAGE_PREVIEW_PATH).toBe("/api/node-packages/preview");
    expect(NODE_PACKAGE_INSTALL_PATH).toBe("/api/node-packages/install");
  });

  it("accepts packaged nodes and plain JSON manifests", () => {
    expect(canImportNodePackageFilename("node.snarknode")).toBe(true);
    expect(canImportNodePackageFilename("node.node.json")).toBe(true);
    expect(canImportNodePackageFilename("node.json")).toBe(true);
    expect(canImportNodePackageFilename("node.txt")).toBe(false);
  });

  it("sends plain manifest JSON as text with consistent filename fields", async () => {
    const file = new File([JSON.stringify({ kind: "snarkroute.node" })], "test-prompt.node.json", { type: "application/json" });
    const payload = await readNodePackageFilePayload(file);

    expect(payload).toEqual({
      filename: "test-prompt.node.json",
      fileName: "test-prompt.node.json",
      text: JSON.stringify({ kind: "snarkroute.node" }),
      dataBase64: undefined
    });
  });

  it("only allows non-bundled packages to be uninstalled from Studio", () => {
    expect(canUninstallNodePackage({ id: "example.local", origin: "installed" })).toBe(true);
    expect(canUninstallNodePackage({ id: "input.text", origin: "bundled" })).toBe(false);
  });

  it("warns before uninstalling a node used by the current route", () => {
    expect(nodePackageIsUsedInRoute("example.local", [{ type: "input.text" }, { type: "example.local" }])).toBe(true);
    expect(uninstallNodeConfirmationMessage("example.local", true)).toContain("existing instances will become missing-node placeholders");
    expect(uninstallNodeConfirmationMessage("example.local", false)).toContain("current canvas instances will not be deleted");
  });
});
