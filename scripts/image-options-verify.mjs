// Live verification of image-gen options + the implicit-draw path (§14).
// Each mode costs 1 image credit — pass which one(s) to run, don't run blindly.
//
// Usage:
//   node scripts/image-options-verify.mjs implicit   # "draw me X" via the normal chat path
//   node scripts/image-options-verify.mjs portrait    # generateImage orientation nudge
//   node scripts/image-options-verify.mjs icon         # style=icon
//   node scripts/image-options-verify.mjs story        # style=story
//   node scripts/image-options-verify.mjs all          # all four (4 credits)
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateImage, getImageArtifactToken, fetchImageBytes, ModelSession } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "image-gen-out");
mkdirSync(OUT, { recursive: true });
const which = process.argv[2] || "implicit";
const run = (name) => which === name || which === "all";

async function save(tag, img) {
  const ext = (img.contentType?.split("/")[1] ?? "png").replace("jpeg", "jpg");
  const path = join(OUT, `verify-${tag}.${ext}`);
  writeFileSync(path, img.data);
  console.log(`  [${tag}] ${img.contentType} ${img.data.length}B ${img.size ?? ""} ${img.orientation ?? ""} -> ${path}`);
}

// The implicit case: a plain chat turn, NO tools, NO generateImage() — just a
// prompt that asks for a drawing. This is what "the user just says generate me an
// image" hits. Agent-less (useAgent=false), exactly like a tool-less proxy request.
if (run("implicit")) {
  console.log('[implicit] ModelSession.run("draw me an image of a green teapot"), agent-less');
  const session = new ModelSession({ useAgent: false });
  const stream = await session.run("draw me an image of a green teapot", "m365-copilot", undefined, false);
  for await (const _ of stream) { /* drain */ }
  const imgs = stream.images ?? [];
  console.log(`[implicit] stream.images=${imgs.length} messageType=${stream.messageType ?? "-"} text=${JSON.stringify((stream.fullText ?? "").slice(0, 60))}`);
  if (imgs.length) {
    const tok = await getImageArtifactToken();
    const { data, contentType } = await fetchImageBytes(imgs[0].referenceUrls[0], tok);
    await save("implicit", { data, contentType, size: imgs[0].size, orientation: imgs[0].orientation });
  } else {
    console.log("[implicit] NO IMAGE — the passive-draw path did not capture one");
  }
}

for (const [mode, prompt, opts] of [
  ["portrait", "a lighthouse on a cliff", { orientation: "portrait" }],
  ["icon", "a lighthouse", { style: "icon" }],
  ["story", "a day in the life of a lighthouse keeper", { style: "story" }],
]) {
  if (!run(mode)) continue;
  console.log(`[${mode}] generateImage(${JSON.stringify(prompt)}, ${JSON.stringify(opts)})`);
  const imgs = await generateImage(prompt, opts);
  console.log(`[${mode}] ${imgs.length} image(s)`);
  for (const img of imgs) await save(mode, img);
  if (!imgs.length) console.log(`[${mode}] NO IMAGE`);
}
