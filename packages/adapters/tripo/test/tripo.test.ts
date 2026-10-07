import { describe, expect, it } from "vitest";
import { buildTripoOperationRequest, createTripoClient } from "../src/index";

describe("Tripo v3 request mapping", () => {
  it("maps retopology params", () => {
    const request = buildTripoOperationRequest("retopology", "file_abc", {
      face_limit: 5000, quad: true, bake: false
    });
    expect(request.endpoint).toBe("/mesh/decimate");
    expect(request.body).toMatchObject({
      input: "file_abc", model: "v2.0", face_limit: 5000, quad: true, bake: false
    });
  });

  it("maps segmentation, texture and rig", () => {
    expect(buildTripoOperationRequest("segment", "file_1", {}).endpoint).toBe("/mesh/segment");
    expect(buildTripoOperationRequest("texture", "file_2", { prompt: "bronze" })).toMatchObject({
      endpoint: "/models/texture",
      body: { input: "file_2", texture_prompt: "bronze" }
    });
    expect(buildTripoOperationRequest("rig", "file_3", { rig_type: "quadruped", spec: "mixamo" })).toMatchObject({
      endpoint: "/animations/rig",
      body: { input: "file_3", model: "v2.5-20260210", rig_type: "quadruped", spec: "mixamo", out_format: "glb" }
    });
  });

  it("uses upload/create/poll protocol", async () => {
    const seen: string[] = [];
    let polls = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/files")) {
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify({ code: 0, data: { file_token: "file_test" } }), {
          status: 200, headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/mesh/decimate")) {
        return new Response(JSON.stringify({ code: 0, data: { task_id: "task_test" } }), { status: 200 });
      }
      if (url.endsWith("/tasks/task_test")) {
        polls++;
        const data = polls === 1
          ? { status: "running", progress: 42 }
          : { status: "success", progress: 100, output: { model_url: "https://cdn.example/model.glb" }, credits_consumed: 12 };
        return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
      }
      throw new Error("unexpected URL " + url);
    };
    const client = createTripoClient({ apiKey: "test_key", fetchImpl: mockFetch, pollIntervalMs: 1, timeoutMs: 2000 });
    // uploadFile needs a real path; protocol flow after upload is tested separately.
    const task = await client.runTask("/mesh/decimate", { input: "file_test" });
    expect(task.taskId).toBe("task_test");
    expect(task.output.model_url).toBe("https://cdn.example/model.glb");
    expect(task.creditsConsumed).toBe(12);
    expect(seen.some((url) => url.endsWith("/mesh/decimate"))).toBe(true);
    expect(polls).toBe(2);
  });
});
