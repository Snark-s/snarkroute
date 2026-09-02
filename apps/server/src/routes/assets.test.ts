import Fastify from "fastify";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { registerAssetRoutes } from "./assets";

const paths: string[] = [];
const previousLimit = process.env.SNARKROUTE_ASSET_MAX_UPLOAD_BYTES;
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { force: true }))); if (previousLimit === undefined) delete process.env.SNARKROUTE_ASSET_MAX_UPLOAD_BYTES; else process.env.SNARKROUTE_ASSET_MAX_UPLOAD_BYTES = previousLimit; });

describe("asset import security", () => {
  it("uses a generated asset id in the safe path and validates image bytes", async () => {
    const app = Fastify(); registerAssetRoutes(app);
    const png = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    const response = await app.inject({ method: "POST", url: "/api/assets/import", payload: { kind: "image", filename: "../../frame.png", dataBase64: png.toString("base64") } });
    expect(response.statusCode).toBe(200);
    const body = response.json(); paths.push(body.path);
    expect(body.id).toMatch(/^asset_[a-f0-9-]+$/i);
    expect(body.path).toContain(`${body.id}-frame.png`);
    expect(body.path).not.toContain("..");
    await app.close();
  });

  it("rejects malformed, mismatched, and oversized content", async () => {
    const app = Fastify(); registerAssetRoutes(app);
    expect((await app.inject({ method: "POST", url: "/api/assets/import", payload: { kind: "image", filename: "bad.png", dataBase64: "***=" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/assets/import", payload: { kind: "video", filename: "fake.mp4", dataBase64: Buffer.from("not a video").toString("base64") } })).statusCode).toBe(400);
    process.env.SNARKROUTE_ASSET_MAX_UPLOAD_BYTES = "2";
    expect((await app.inject({ method: "POST", url: "/api/assets/import", payload: { kind: "file", filename: "large.bin", dataBase64: Buffer.from("123").toString("base64") } })).statusCode).toBe(413);
    await app.close();
  });
});
