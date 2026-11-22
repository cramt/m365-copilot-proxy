import { z } from "zod/v4";
import {
  generateImage,
  ImageGenerationError,
  type GeneratedImage,
  type GenerateImageOptions,
  type ImageGenFailureReason,
  type ImageOrientation,
} from "@m365-copilot/core";

// OpenAI's POST /v1/images/generations on top of core's generateImage() (§14).
//
// M365 draws one picture per turn and picks its own resolution, so the request
// only accepts what we can honour: n is 1, the bytes come back inline (the
// artifact URL 401s without the designerappservice token, so a `url` response
// would be useless to the client), and `size` only steers orientation.

const OpenAiSize = z.enum(["auto", "256x256", "512x512", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"]);

export const ImageGenerationRequest = z.object({
  prompt: z.string().trim().min(1),
  // Clients send their own model name (dall-e-3, gpt-image-1); the image tool
  // runs under M365's own tone whatever it is, so it's accepted and not used.
  model: z.string().optional(),
  n: z.literal(1).optional(),
  size: OpenAiSize.optional(),
  response_format: z.literal("b64_json").optional(),
  // Extensions: the two knobs generateImage() has. `orientation` wins over `size`.
  orientation: z.enum(["landscape", "portrait", "square"]).optional(),
  style: z.enum(["natural", "icon", "story", "designer"]).optional(),
});
export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequest>;

export function orientationForSize(size: z.infer<typeof OpenAiSize> | undefined): ImageOrientation | undefined {
  if (size === undefined || size === "auto") return undefined;
  const [w, h] = size.split("x").map(Number);
  return w > h ? "landscape" : w < h ? "portrait" : "square";
}

const FAILURE_STATUS: Record<ImageGenFailureReason, { status: number; code: string }> = {
  quota_exceeded: { status: 429, code: "rate_limit_exceeded" },
  capacity: { status: 503, code: "server_overloaded" },
  content_filtered: { status: 400, code: "content_policy_violation" },
  no_image: { status: 502, code: "no_image" },
};

export interface ImageGenerationDeps {
  signal?: AbortSignal;
  /** Seam for tests; defaults to core's generateImage. */
  generate?: (prompt: string, opts: GenerateImageOptions) => Promise<GeneratedImage[]>;
}

export async function handleImageGeneration(
  body: ImageGenerationRequest,
  { signal, generate = generateImage }: ImageGenerationDeps = {},
): Promise<Response> {
  let images: GeneratedImage[];
  try {
    images = await generate(body.prompt, {
      signal,
      orientation: body.orientation ?? orientationForSize(body.size),
      style: body.style,
    });
  } catch (err: any) {
    if (err instanceof ImageGenerationError) {
      const { status, code } = FAILURE_STATUS[err.reason];
      return errorResponse(status, code, err.message);
    }
    return errorResponse(502, "upstream_error", err?.message ?? String(err));
  }
  // generateImage returns [] (not an error) when the model answered in words
  // instead of drawing, which for this endpoint is still a failure.
  if (images.length === 0) {
    const { status, code } = FAILURE_STATUS.no_image;
    return errorResponse(status, code, "M365 Copilot answered without drawing an image; rephrase the prompt as an image request.");
  }
  return new Response(
    JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: images.map((img) => ({ b64_json: img.base64 })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: status === 400 ? "invalid_request_error" : "api_error", code } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
