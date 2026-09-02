import { describe, expect, it } from "vitest";
import { copyImageUrlToClipboard, readClipboardImage } from "./components.js";

describe("canvas action clipboard input", () => {
  it("turns the first clipboard image into a named File", async () => {
    const image = new Blob(["image"], { type: "image/png" });
    const clipboard = {
      read: async () => [{
        types: ["text/plain", "image/png"],
        presentationStyle: "unspecified",
        getType: async (type: string) => type === "image/png" ? image : new Blob()
      } as ClipboardItem]
    } as Pick<Clipboard, "read">;

    const file = await readClipboardImage(clipboard);

    expect(file).toBeInstanceOf(File);
    expect(file?.name).toMatch(/^clipboard-\d+\.png$/);
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBe(image.size);
  });

  it("returns null when the clipboard has no image", async () => {
    const clipboard = {
      read: async () => [{
        types: ["text/plain"],
        presentationStyle: "unspecified",
        getType: async () => new Blob()
      } as ClipboardItem]
    } as Pick<Clipboard, "read">;

    await expect(readClipboardImage(clipboard)).resolves.toBeNull();
  });
});

describe("canvas action clipboard output", () => {
  it("copies the fetched image blob to the clipboard", async () => {
    const image = new Blob(["image"], { type: "image/png" });
    const written: ClipboardItem[][] = [];
    class TestClipboardItem {
      constructor(readonly data: Record<string, Blob>) {}
    }
    const clipboard = {
      write: async (items: ClipboardItem[]) => { written.push(items); }
    } as Pick<Clipboard, "write">;
    const fetchImage = async () => ({
      ok: true,
      status: 200,
      blob: async () => image
    } as Response);

    await copyImageUrlToClipboard(
      "/result.png",
      clipboard,
      fetchImage as typeof fetch,
      TestClipboardItem as unknown as typeof ClipboardItem
    );

    expect(written).toHaveLength(1);
    expect((written[0]?.[0] as unknown as TestClipboardItem).data["image/png"]).toBe(image);
  });

  it("rejects a non-image response", async () => {
    const clipboard = { write: async () => undefined } as Pick<Clipboard, "write">;
    const fetchImage = async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["text"], { type: "text/plain" })
    } as Response);

    await expect(copyImageUrlToClipboard(
      "/result.txt",
      clipboard,
      fetchImage as typeof fetch,
      class {} as unknown as typeof ClipboardItem
    )).rejects.toThrow("not an image");
  });
});
