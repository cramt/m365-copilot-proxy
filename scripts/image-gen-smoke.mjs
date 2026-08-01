// Live smoke test for the core image-gen API (§14, H14.1 + H14.6 end to end).
// Sends ONE image prompt through OUR proxy path (not the GUI) and downloads the
// bytes. Costs 1 image credit — do not loop.
//
// Usage: M365_NO_INTERACTIVE=1 node scripts/image-gen-smoke.mjs ["prompt"]
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateImage } from "../packages/core/dist/index.mjs";

const OUT = join(process.cwd(), "scripts", "image-gen-out");
mkdirSync(OUT, { recursive: true });
const prompt = process.argv[2] || "A minimalist flat-design logo of a lighthouse, teal and white.";

console.log(`[smoke] generating: ${JSON.stringify(prompt)}`);
const t0 = Date.now();
const images = await generateImage(prompt);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`[smoke] ${images.length} image(s) in ${secs}s`);
for (const [i, img] of images.entries()) {
  const path = join(OUT, `img-${i}.${(img.contentType.split("/")[1] ?? "png").replace("jpeg", "jpg")}`);
  writeFileSync(path, img.data);
  console.log(`  [${i}] ${img.contentType} ${img.data.length} bytes ${img.size ?? ""} ${img.orientation ?? ""} -> ${path}`);
  console.log(`      url: ${img.url.slice(0, 90)}…`);
}
if (images.length === 0) console.log("[smoke] NO IMAGES — see debug log (M365_DEBUG=1) for messageType/Disengaged");
