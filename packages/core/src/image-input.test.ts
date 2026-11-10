import { describe, it, expect, vi, afterEach } from "vitest";
import { uploadImage, imageUrls } from "./image-input.js";

afterEach(() => vi.unstubAllGlobals());

describe("uploadImage", () => {
  it("posts the data URL to UploadFile and returns an ImageFile annotation", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ docId: "doc-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const a = await uploadImage("tok", "conv-1", "data:image/jpeg;base64,/9j/");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://substrate.office.com/m365Copilot/UploadFile");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("FileBase64")).toBe("data:image/jpeg;base64,/9j/");
    expect(form.get("conversationId")).toBe("conv-1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(a).toMatchObject({ id: "doc-1", messageAnnotationType: "ImageFile", messageAnnotationMetadata: { fileType: "jpg" } });
  });

  it("fails loudly on a refusal, a missing docId, or something that isn't an image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(uploadImage("t", "c", "data:image/png;base64,AA")).rejects.toThrow("UploadFile 403");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(uploadImage("t", "c", "data:image/png;base64,AA")).rejects.toThrow("no docId");
    await expect(uploadImage("t", "c", "https://example.com/a.png")).rejects.toThrow("data URL");
  });
});

describe("imageUrls", () => {
  it("collects image parts in order and ignores text-only messages", () => {
    expect(imageUrls([
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "text", text: "two" }, { type: "image_url", image_url: { url: "data:image/png;base64,A" } }] },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,B" } }] },
    ])).toEqual(["data:image/png;base64,A", "data:image/png;base64,B"]);
  });
});
