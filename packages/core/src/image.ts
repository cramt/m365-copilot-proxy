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
import { createLogger, trunc } from "./log.js";
import { awaitTurnBudget } from "./turn-budget.js";
import type { CapturedImage } from "./copilot.js";

const log = createLogger("image");

/** Why an image turn produced no image. `quota_exceeded` is the daily image cap
 *  (separate from the ~600-msg chat quota, §14); `capacity` is transient server
 *  load; `content_filtered` is a refusal on the prompt; `no_image` means the model
 *  simply didn't draw (e.g. the prompt wasn't actually an image request). */
export type ImageGenFailureReason = "quota_exceeded" | "capacity" | "content_filtered" | "no_image";

export class ImageGenerationError extends Error {
  constructor(public reason: ImageGenFailureReason, message: string) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

// Classify a no-image turn from the bot's text (§14 H14.4). Only meaningful when
// zero images came back — then the text is a status/refusal, not a caption, so
// these patterns can't false-positive on a real description. The quota wording is
// verbatim from a live exhaustion: "Sorry, I can't generate any more images today.
// Try again tomorrow…".
export function classifyImageFailure(text: string): ImageGenFailureReason {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return "no_image";
  if (/can.?t generate any more images|no more images (today|right now)|reached (your|the)[^.]*image|image (generation )?(limit|quota)|try again tomorrow/.test(t)) return "quota_exceeded";
  if (/trouble (creating|generating|making)[^.]*image|couldn.?t (create|generate)[^.]*image|try again (later|in a (bit|moment|few))/.test(t)) return "capacity";
  if (/can.?t (create|generate|make) (that|this|an? )[^.]*image|unable to (create|generate)[^.]*image|against[^.]*(policy|guideline)|can.?t help (with|create) that/.test(t)) return "content_filtered";
  return "no_image";
}

/** Aspect the model renders at. It picks this from the prompt (the `image_gen`
 *  tool call carries an `orientation` arg); we nudge it via a prompt directive. */
export type ImageOrientation = "landscape" | "portrait" | "square";

/** Generation type. The GUI enables all of these via optionsSets (always on) and
 *  the model picks by prompt; `style` appends the matching directive.
 *  - `natural`  — let the model decide (default; a plain prompt)
 *  - `icon`     — app/UI icon framing (flux icon dimensions)
 *  - `story`    — multi-panel story/comic (flux story)
 *  - `designer` — polished graphic-design framing (designer dimensions) */
export type ImageStyle = "natural" | "icon" | "story" | "designer";

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
  /** Abort the chat turn and artifact downloads. */
  signal?: AbortSignal;
  /** If true, don't download bytes — return URLs only (data/base64 empty). Lets a
   *  caller stream the fetch itself, or skip the download when only the URL is
   *  wanted. */
  urlsOnly?: boolean;
  /** Nudge the render aspect. Omit to let the model choose from the prompt. */
  orientation?: ImageOrientation;
  /** Nudge the generation type. `natural` (default) leaves the prompt untouched. */
  style?: ImageStyle;
}

/** Build the effective prompt from the caller's text + structured options. Image
 *  type/orientation aren't request parameters — the model reads them out of the
 *  prompt (same as the GUI's meta-prompting), so we append concise directives it
 *  understands rather than fabricate tool-call arguments we can't set. */
export function buildImagePrompt(prompt: string, opts: { orientation?: ImageOrientation; style?: ImageStyle } = {}): string {
  const directives: string[] = [];
  switch (opts.style) {
    case "icon": directives.push("Render it as a clean app icon."); break;
    case "story": directives.push("Render it as a multi-panel illustrated story."); break;
    case "designer": directives.push("Render it as a polished graphic-design composition."); break;
    case "natural": case undefined: break;
  }
  switch (opts.orientation) {
    case "landscape": directives.push("Use a landscape (wide, 16:9) orientation."); break;
    case "portrait": directives.push("Use a portrait (tall, 9:16) orientation."); break;
    case "square": directives.push("Use a square (1:1) orientation."); break;
    case undefined: break;
  }
  return directives.length ? `${prompt.trim()}\n\n${directives.join(" ")}` : prompt;
}

/**
 * Fetch a generated-image artifact's bytes. The URL 401s without the
 * designerappservice token (§14 F14.6).
 */
export async function fetchImageBytes(
  url: string,
  artifactToken: string,
  signal?: AbortSignal,
): Promise<{ data: Buffer; contentType: string }> {
  // Validate the raw authority before WHATWG URL parsing can normalize controls,
  // backslashes or userinfo. Only this host is evidenced in §14 F14.6; the token
  // audience (designerappservice) is NOT another trusted artifact host. Never
  // decode/rebuild the signed path or query: fetch receives the original string.
  if (/[\x00-\x20\x7f\\]/.test(url) ||
      !/^https:\/\/designerapp\.officeapps\.live\.com(?::443)?(?:[/?#]|$)/i.test(url)) {
    throw new Error("Untrusted image artifact URL");
  }
  // Native Fetch serializes WHATWG URLs even when given the original string:
  // dot segments (including mixed/encoded dots), Unicode and some punctuation
  // would change a signed locator. Compare serialization without decoding or
  // replacing the caller's bytes. Fragments are never part of a request target;
  // require an explicit path to avoid an implicit slash as well.
  const locator = url.match(/^https:\/\/[^/]+(\/[^#]*)$/i)?.[1];
  const parsed = new URL(url);
  if (!locator || parsed.href.slice(parsed.origin.length) !== locator) {
    throw new Error("Untrusted image artifact URL");
  }
  if (signal?.aborted) throw new Error("Image artifact fetch aborted");

  // Timers cannot run while ready reads keep scheduling promise microtasks.
  // Enforce a monotonic deadline as well, through headers, EOF and assembly.
  const deadline = performance.now() + 60_000;
  // Cancellation reasons may contain secrets.
  const configuredLimit = Number(process.env.M365_MAX_IMAGE_BYTES);
  const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit : 20 * 1024 * 1024;
  const controller = new AbortController();
  let failure = "Image artifact fetch failed";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const retire = () => {
    const cancellation = reader ? reader.cancel() : response?.body?.cancel();
    void cancellation?.catch(() => {});
  };
  let rejectCancellation!: (reason: Error) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  // A synchronous deadline check can abort before any race is listening (e.g.
  // fetch throws synchronously or the final buffer assembly exhausts the budget).
  void cancelled.catch(() => {});
  const abort = (message: string) => {
    if (controller.signal.aborted) return;
    failure = message;
    controller.abort();
    retire();
    rejectCancellation(new Error(message));
  };
  const checkDeadline = () => {
    if (performance.now() >= deadline) abort("Image artifact fetch timed out");
    if (controller.signal.aborted) throw new Error(failure);
  };
  const callerAbort = () => abort("Image artifact fetch aborted");
  signal?.addEventListener("abort", callerAbort, { once: true });
  const timer = setTimeout(() => abort("Image artifact fetch timed out"), 60_000);
  try {
    checkDeadline();
    const pending = fetch(url, {
      headers: { Authorization: `Bearer ${artifactToken}` },
      redirect: "error",
      signal: controller.signal,
    }).then((res) => {
      // Also retire a late response from a transport which ignored cancellation.
      if (controller.signal.aborted) void res.body?.cancel().catch(() => {});
      return res;
    });
    response = await Promise.race([pending, cancelled]);
    checkDeadline();
    if (!response.ok) {
      failure = `Image artifact fetch failed: HTTP ${response.status}`;
      throw new Error(failure);
    }
    if (Number(response.headers.get("content-length")) > limit) {
      failure = "Image artifact exceeds the configured size limit";
      throw new Error(failure);
    }
    const contentType = response.headers.get("content-type") ?? "image/png";
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        checkDeadline();
        const { value, done } = await Promise.race([reader.read(), cancelled]);
        checkDeadline();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          failure = "Image artifact exceeds the configured size limit";
          throw new Error(failure);
        }
        chunks.push(value);
      }
    }
    checkDeadline();
    const data = Buffer.concat(chunks, size);
    checkDeadline();
    return { data, contentType };
  } catch {
    retire();
    controller.abort();
    // Neither URLs, statusText, transport errors nor caller reasons are safe.
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", callerAbort);
    reader?.releaseLock();
  }
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
  const effectivePrompt = buildImagePrompt(prompt, { orientation: opts.orientation, style: opts.style });

  const session = new CopilotSession();
  await awaitTurnBudget({ signal: opts.signal });
  const stream = await session.chat(token, effectivePrompt, model, opts.signal, { generateImages: true });

  // Image frames arrive as Progress updates and again in the final type:2 item;
  // draining the stream to completion is what guarantees we've seen them all.
  for await (const _ of stream) {
    // discard any text ("Loading image" etc.) — the image is the payload.
  }

  const captured: CapturedImage[] = stream.images;
  if (captured.length === 0) {
    // No image: quota, capacity, a content refusal, or the model just didn't draw.
    // The first three are real failures the caller must distinguish (quota → 429);
    // only surface them as an error, and let a genuine non-draw return [] quietly.
    const reason = classifyImageFailure(stream.fullText ?? "");
    if (reason !== "no_image") {
      const msg = stream.fullText?.trim() || `Image generation failed: ${reason}`;
      log.info(`Image gen failed (${reason}) for ${JSON.stringify(prompt.slice(0, 80))}: ${trunc(msg, 120)}`);
      throw new ImageGenerationError(reason, msg);
    }
    log.info(`No image generated for prompt ${JSON.stringify(prompt.slice(0, 80))} (model did not draw)`);
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
    const { data, contentType } = await fetchImageBytes(url, artifactToken, opts.signal);
    out.push({ url, contentType, data, base64: data.toString("base64"), size: meta.size, orientation: meta.orientation });
  }
  return out;
}
