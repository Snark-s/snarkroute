import { afterEach, describe, expect, it, vi } from "vitest";
import { runNode } from "../../../examples/custom-nodes/seedance-2-video.snarknode/executor";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("Seedance example node", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the BytePlus ModelArk content-generation task contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "cgt-123" }))
      .mockResolvedValueOnce(jsonResponse({
        id: "cgt-123",
        status: "succeeded",
        content: { video_url: "https://cdn.byteplus.example/output.mp4" }
      }))
      .mockResolvedValueOnce(new Response(Buffer.from("video"), {
        status: 200,
        headers: { "content-type": "video/mp4" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const writeBase64 = vi.fn().mockResolvedValue({
      localPath: "run/assets/seedance-2.mp4",
      mimeType: "video/mp4"
    });
    const result = await runNode({
      env: { ARK_API_KEY: "ark-test" },
      params: {
        providerBackend: "byteplus-modelark",
        model: "seedance-2.0",
        prompt: "A cinematic orbit.",
        duration: "5",
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: true,
        pollIntervalMs: 1
      },
      inputs: {
        firstFrame: { url: "https://assets.example/first-frame.png" }
      },
      assets: { writeBase64 }
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
      expect.objectContaining({ method: "POST" })
    );
    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(createBody).toEqual({
      model: "dreamina-seedance-2-0-260128",
      content: [
        { type: "text", text: "A cinematic orbit." },
        {
          type: "image_url",
          image_url: { url: "https://assets.example/first-frame.png" },
          role: "first_frame"
        }
      ],
      duration: 5,
      resolution: "720p",
      ratio: "16:9",
      generate_audio: true
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/cgt-123",
      expect.objectContaining({ method: "GET" })
    );
    expect(writeBase64).toHaveBeenCalledWith(
      "seedance-2.mp4",
      Buffer.from("video").toString("base64"),
      "video/mp4"
    );
    expect(result.outputs.output).toMatchObject({
      status: "succeeded",
      content: { video_url: "https://cdn.byteplus.example/output.mp4" }
    });
  });
});
