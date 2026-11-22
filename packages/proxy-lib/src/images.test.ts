import { describe, it, expect } from "vitest";
import { ImageGenerationError, type GeneratedImage, type GenerateImageOptions } from "@m365-copilot/core";
import { ImageGenerationRequest, handleImageGeneration, orientationForSize } from "./images.js";

const png = (bytes: string): GeneratedImage => ({
  url: "https://example.invalid/artifact",
  contentType: "image/png",
  data: Buffer.from(bytes),
  base64: Buffer.from(bytes).toString("base64"),
});

describe("ImageGenerationRequest", () => {
  it("accepts a plain OpenAI request", () => {
    const body = ImageGenerationRequest.parse({ model: "dall-e-3", prompt: " a teapot ", n: 1, size: "1024x1024", response_format: "b64_json" });
    expect(body.prompt).toBe("a teapot");
  });

  it("refuses what M365 can't honour", () => {
    expect(() => ImageGenerationRequest.parse({ prompt: "x", n: 2 })).toThrow();
    expect(() => ImageGenerationRequest.parse({ prompt: "x", response_format: "url" })).toThrow();
    expect(() => ImageGenerationRequest.parse({ prompt: "   " })).toThrow();
    expect(() => ImageGenerationRequest.parse({ prompt: "x", style: "watercolour" })).toThrow();
  });
});

describe("orientationForSize", () => {
  it("reads orientation off the aspect", () => {
    expect(orientationForSize("1792x1024")).toBe("landscape");
    expect(orientationForSize("1024x1536")).toBe("portrait");
    expect(orientationForSize("512x512")).toBe("square");
    expect(orientationForSize("auto")).toBeUndefined();
    expect(orientationForSize(undefined)).toBeUndefined();
  });
});

describe("handleImageGeneration", () => {
  it("returns the bytes as b64_json and passes the knobs through", async () => {
    let seen: GenerateImageOptions | undefined;
    const res = await handleImageGeneration(
      ImageGenerationRequest.parse({ prompt: "a teapot", size: "1024x1792", style: "icon" }),
      { generate: async (_p, opts) => { seen = opts; return [png("PNGDATA")]; } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ b64_json: Buffer.from("PNGDATA").toString("base64") }]);
    expect(seen?.orientation).toBe("portrait");
    expect(seen?.style).toBe("icon");
  });

  it("lets an explicit orientation override size", async () => {
    let seen: GenerateImageOptions | undefined;
    await handleImageGeneration(
      ImageGenerationRequest.parse({ prompt: "x", size: "1024x1792", orientation: "landscape" }),
      { generate: async (_p, opts) => { seen = opts; return [png("x")]; } },
    );
    expect(seen?.orientation).toBe("landscape");
  });

  it.each([
    ["quota_exceeded", 429],
    ["capacity", 503],
    ["content_filtered", 400],
  ] as const)("maps %s to %i", async (reason, status) => {
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "x" }), {
      generate: async () => { throw new ImageGenerationError(reason, "nope"); },
    });
    expect(res.status).toBe(status);
    expect((await res.json()).error.message).toBe("nope");
  });

  it("treats a turn that didn't draw as a failure", async () => {
    const res = await handleImageGeneration(ImageGenerationRequest.parse({ prompt: "x" }), { generate: async () => [] });
    expect(res.status).toBe(502);
  });
});
