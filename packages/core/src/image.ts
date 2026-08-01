// Image generation (§14). M365 Copilot generates images through a built-in
// server-side tool; the picture comes back on a GraphicArt frame as a URL, never
// as chat text, and the bytes sit behind a separate auth boundary. This module
// ties the three pieces together into one call:
//
//   1. drive an agent-less chat turn with image gen enabled (CopilotSession),
//   2. read the image URL(s) off `stream.images`,
//   3. fetch the bytes with the designerappservice token (getImageArtifactToken).
//
// Full protocol write-up: docs/hypotheses.md §14.

import { getToken, getImageArtifactToken } from "./auth.js";
import { CopilotSession } from "./session.js";
import { createLogger } from "./log.js";
import type { CapturedImage } from "./copilot.js";

const log = createLogger("image");

export interface GeneratedImage {
  /** The artifact URL the bytes were fetched from. */
  url: string;
  contentType: string;
  data: Buffer;
  /** `data` as base64 — convenient for OpenAI-style `b64_json` responses. */
  base64: string;
  size?: string;
  orientation?: string;
}

export interface GenerateImageOptions {
  /** Model/tone to run under. Defaults to `m365-copilot` (tone `Magic`, what the
   *  official client uses for image gen). */
  model?: string;
  /** Sydney chat token. Fetched via getToken() when omitted. */
  token?: string;
  /** designerappservice token for artifact fetches. Fetched via
   *  getImageArtifactToken() when omitted. Pass it in to avoid re-acquiring
   *  across a batch. */
  artifactToken?: string;
  /** Abort the underlying chat turn. */
  signal?: AbortSignal;
  /** If true, don't download bytes — return URLs only (data/base64 empty). Lets a
   *  caller stream the fetch itself, or skip the download when only the URL is
   *  wanted. */
  urlsOnly?: boolean;
}

/**
 * Fetch a generated-image artifact's bytes. The URL 401s without the
 * designerappservice token (§14 F14.6).
 */
export async function fetchImageBytes(
  url: string,
  artifactToken: string,
): Promise<{ data: Buffer; contentType: string }> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${artifactToken}` } });
  if (!res.ok) {
    throw new Error(`Image artifact fetch failed: ${res.status} ${res.statusText} for ${url.slice(0, 120)}`);
  }
  const contentType = res.headers.get("content-type") ?? "image/png";
  const data = Buffer.from(await res.arrayBuffer());
  return { data, contentType };
}

/**
 * Generate one or more images from a prompt and return them with bytes attached.
 *
 * Runs a single agent-less Copilot turn — image gen is agent-less (the declarative
 * agent hardcodes generateImages:false), so this always uses a fresh plain session.
 */
export async function generateImage(
  prompt: string,
  opts: GenerateImageOptions = {},
): Promise<GeneratedImage[]> {
  const token = opts.token ?? (await getToken());
  const model = opts.model ?? "m365-copilot";

  const session = new CopilotSession();
  const stream = await session.chat(token, prompt, model, opts.signal, { generateImages: true });

  // Image frames arrive as Progress updates and again in the final type:2 item;
  // draining the stream to completion is what guarantees we've seen them all.
  for await (const _ of stream) {
    // discard any text ("Loading image" etc.) — the image is the payload.
  }

  const captured: CapturedImage[] = stream.images;
  if (captured.length === 0) {
    const detail = stream.messageType === "Disengaged" ? " (Disengaged)" : "";
    log.info(`No images generated for prompt ${JSON.stringify(prompt.slice(0, 80))}${detail}`);
    return [];
  }
  log.info(`Captured ${captured.length} image(s) for prompt ${JSON.stringify(prompt.slice(0, 80))}`);

  const urls = captured
    .map((c) => ({ url: c.referenceUrls[0], meta: c }))
    .filter((x): x is { url: string; meta: CapturedImage } => !!x.url);

  if (opts.urlsOnly) {
    return urls.map(({ url, meta }) => ({
      url, contentType: "image/png", data: Buffer.alloc(0), base64: "",
      size: meta.size, orientation: meta.orientation,
    }));
  }

  const artifactToken = opts.artifactToken ?? (await getImageArtifactToken());
  if (!artifactToken) {
    throw new Error("Could not acquire designerappservice token to fetch image bytes");
  }

  const out: GeneratedImage[] = [];
  for (const { url, meta } of urls) {
    const { data, contentType } = await fetchImageBytes(url, artifactToken);
    out.push({ url, contentType, data, base64: data.toString("base64"), size: meta.size, orientation: meta.orientation });
  }
  return out;
}
