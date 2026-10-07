import { createReplicate3DNodeRunner } from "./packages/adapters/replicate/src/index.ts";

const calls = [];
const fakeFetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? String(init.body) : "" });
  if (String(url).includes("/models/firtoz/trellis")) {
    return new Response(JSON.stringify({ latest_version: { id: "deadbeefdeadbeefdeadbeefdeadbeef" } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (String(url).endsWith("/files")) {
    return new Response(JSON.stringify({ id: "file-test", urls: { get: "https://api.replicate.com/v1/files/file-test" } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (String(url).endsWith("/predictions")) {
    return new Response(JSON.stringify({ id: "pred-test", status: "failed", error: "stop-after-capture" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ id: "pred-test", status: "failed", error: "stop-after-capture" }), { status: 200, headers: { "content-type": "application/json" } });
};

const runner = createReplicate3DNodeRunner({ token: "test-token", fetchImpl: fakeFetch });
try {
  await runner({
    node: { id: "generate", type: "ai.3d.generate", params: {} },
    params: {
      model: "firtoz/trellis",
      providerModelId: "firtoz/trellis",
      images: [{
        assetId: "img-0",
        path: "Y:\\Приложения\\Jabberwock Mixar Local\\generation_inputs\\jbgen-da8f501ed30540b88bf72c52a2e2c6e9\\ref_00.png",
        localPath: "Y:\\Приложения\\Jabberwock Mixar Local\\generation_inputs\\jbgen-da8f501ed30540b88bf72c52a2e2c6e9\\ref_00.png",
        role: "sourceImage",
        index: 0
      }],
      texture_size: 1024,
      mesh_simplify: 0.95,
      generate_normal: false,
      save_gaussian_ply: false
    },
    inputs: {},
    context: {
      runId: "capture",
      outputDirectory: "Y:\\Приложения\\Jabberwock Mixar Local\\capture",
      signal: new AbortController().signal,
      reportProgress: async () => {}
    }
  });
} catch (e) {
  console.log("RUNNER_ERROR", e instanceof Error ? e.message : String(e));
}
const post = calls.find(x => x.url.endsWith("/predictions"));
console.log("CALLS", JSON.stringify(calls.map(x => ({...x, body: x.body.length > 1200 ? x.body.slice(0,1200)+"..." : x.body})), null, 2));
if (!post) process.exit(2);
const parsed = JSON.parse(post.body);
console.log("INPUT_KEYS", Object.keys(parsed.input || {}));
console.log("IMAGES_COUNT", Array.isArray(parsed.input?.images) ? parsed.input.images.length : -1);
console.log("FIRST_IMAGE_PREFIX", Array.isArray(parsed.input?.images) ? String(parsed.input.images[0]).slice(0,40) : "");
