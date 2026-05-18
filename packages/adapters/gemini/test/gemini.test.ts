import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildNanoBanana2Parts, createGeminiClient, createGeminiLlmNodeRunner, createNanoBanana2NodeRunner, prepareImageInlineData } from "../src/index";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe("Gemini adapter", () => {
  it("fails clearly without a token", async () => {
    const client = createGeminiClient({ token: "" });
    await expect(client.generateContent("gemini-test", [{ text: "hi" }])).rejects.toThrow("GEMINI_API_KEY is not configured.\nOpen Settings \u2192 Secrets \u2192 Gemini and paste your token.");
  });

  it("builds Nano Banana 2 parts with text and image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-gemini-parts-"));
    const imagePath = join(directory, "input.png");
    await writeFile(imagePath, Buffer.from("png"));
    const parts = await buildNanoBanana2Parts({ prompt: "make it shiny", image: imagePath });
    expect(parts[0]).toEqual({ text: "make it shiny" });
    expect(parts[1]).toMatchObject({ inlineData: { mimeType: "image/png" } });
  });

  it("builds Nano Banana 2 parts with multiple images", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-gemini-multi-parts-"));
    const first = join(directory, "first.png");
    const second = join(directory, "second.png");
    await writeFile(first, Buffer.from("one"));
    await writeFile(second, Buffer.from("two"));
    const parts = await buildNanoBanana2Parts({ prompt: "combine them", images: [first, second] });
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatchObject({ inlineData: { mimeType: "image/png" } });
    expect(parts[2]).toMatchObject({ inlineData: { mimeType: "image/png" } });
  });

  it("converts local image input to inline data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-gemini-image-"));
    const imagePath = join(directory, "input.webp");
    await writeFile(imagePath, Buffer.from("webp"));
    await expect(prepareImageInlineData(imagePath)).resolves.toMatchObject({ mimeType: "image/webp", data: Buffer.from("webp").toString("base64") });
  });

  it("Nano Banana 2 runner writes returned inline image locally", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 12 },
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("image").toString("base64") } }]
            }
          }
        ]
      })
    );
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-gemini-run-"));
    const runner = createNanoBanana2NodeRunner({ token: "token", fetchImpl });
    const result = await runner({
      node: { id: "banana", type: "gemini.nano-banana-2", params: {} },
      params: { prompt: "panel prompt" },
      inputs: { prompt: { text: "connected prompt" } },
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    expect(result.output).toMatchObject({ model: "gemini-3.1-flash-image-preview", image: { mimeType: "image/png", filename: expect.stringMatching(/banana-/) } });
    expect(result.providerUsage).toMatchObject({ provider: "gemini", model: "gemini-3.1-flash-image-preview", status: "succeeded" });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.contents[0].parts[0].text).toContain("Return an image result");
    expect(body.contents[0].parts[0].text).toContain("connected prompt");
    expect(result.output).toMatchObject({ cost: { amountUsd: 0.039 }, inputImageCount: 0 });
    expect(JSON.stringify(result.providerUsage)).not.toContain("token");
  });

  it("passes aspect ratio and image size to Gemini image config", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("image").toString("base64") } }]
            }
          }
        ]
      })
    );
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-gemini-config-"));
    const runner = createNanoBanana2NodeRunner({ token: "token", fetchImpl });
    await runner({
      node: { id: "banana", type: "gemini.nano-banana-2", params: {} },
      params: { prompt: "make an image", aspectRatio: "16:9", imageSize: "4K" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "4K" });
  });

  it("Gemini LLM runner sends system prompt and returns text", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "A clean funny image prompt." }]
            }
          }
        ]
      })
    );
    const runner = createGeminiLlmNodeRunner({ token: "token", fetchImpl });
    const result = await runner({
      node: { id: "llm", type: "gemini.llm", params: {} },
      params: { systemPrompt: "Rewrite safely.", prompt: "rough joke", model: "gemini-test" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory: "", nodeOutputs: {}, log: () => undefined }
    });

    expect(result.output).toMatchObject({ text: "A clean funny image prompt.", model: "gemini-test", status: "succeeded", cost: { amountUsd: null } });
    expect(result.providerUsage).toMatchObject({ provider: "gemini", model: "gemini-test", status: "succeeded" });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.systemInstruction.parts[0].text).toBe("Rewrite safely.");
    expect(body.contents[0].parts[0].text).toBe("rough joke");
    expect(body.generationConfig.responseModalities).toEqual(["TEXT"]);
    expect(JSON.stringify(result.providerUsage)).not.toContain("token");
  });

  it("Gemini LLM runner sends image inputs to vision-capable text models", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "The image shows a route sketch." }]
            }
          }
        ]
      })
    );
    const runner = createGeminiLlmNodeRunner({ token: "token", fetchImpl });

    await runner({
      node: { id: "llm", type: "gemini.llm", params: {} },
      params: { prompt: "Describe it", model: "gemini-test" },
      inputs: { images: "data:image/png;base64,aaa" },
      context: { runId: "r", route: {} as never, outputDirectory: "", nodeOutputs: {}, log: () => undefined }
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.contents[0].parts).toEqual([
      { text: "Describe it" },
      { inlineData: { mimeType: "image/png", data: "aaa" } }
    ]);
  });

  it("Gemini LLM runner estimates known model cost from usage metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 2000 },
        candidates: [
          {
            content: {
              parts: [{ text: "A cheaper clean prompt." }]
            }
          }
        ]
      })
    );
    const runner = createGeminiLlmNodeRunner({ token: "token", fetchImpl });
    const result = await runner({
      node: { id: "llm", type: "gemini.llm", params: {} },
      params: { prompt: "rough joke", model: "gemini-2.5-flash-lite" },
      inputs: {},
      context: { runId: "r", route: {} as never, outputDirectory: "", nodeOutputs: {}, log: () => undefined }
    });

    expect(result.output).toMatchObject({
      cost: {
        amountUsd: 0.0009,
        inputTokens: 1000,
        outputTokens: 2000,
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.4
      }
    });
  });

  it("Nano Banana 2 runner reports provider text when no image is returned", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: "I can describe the edit, but I did not generate an image." }]
            }
          }
        ]
      })
    );
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-gemini-no-image-"));
    const runner = createNanoBanana2NodeRunner({ token: "token", fetchImpl });
    await expect(
      runner({
        node: { id: "banana", type: "gemini.nano-banana-2", params: {} },
        params: { prompt: "make an image" },
        inputs: {},
        context: { runId: "r", route: {} as never, outputDirectory, nodeOutputs: {}, log: () => undefined }
      })
    ).rejects.toThrow("Provider text response: I can describe the edit");
  });
});
