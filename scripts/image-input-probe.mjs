// H8.10: can a turn carry an image? Uploads IMAGE through ModelSession (the proxy's
// own path: /m365Copilot/UploadFile → docId → an ImageFile messageAnnotation) and
// asks about content the model can't guess. Arms, one fresh conversation each:
//   image     — agent-less
//   agent     — with the tool agent (the path GPT tool requests take)
//   noimage   — control: the same question, no image
//
//   IMAGE=chart.png EXPECT="4821,37,82,15" node scripts/image-input-probe.mjs
//   ARMS=image,noimage MODEL=gpt-5.5-think-deeper ...
//
// Falsification: the image arms answer no better than the control.
// Cost: one conversation of one message per arm.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { ModelSession } from "../packages/core/dist/index.mjs";

const IMAGE = process.env.IMAGE;
if (!IMAGE) throw new Error("set IMAGE=path/to/picture.png");
const EXPECT = (process.env.EXPECT ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MODEL = process.env.MODEL ?? "gpt-5.6-think-deeper";
const QUESTION = process.env.QUESTION ??
  "Look at the attached image. What is its title, and what numbers does it show? Answer in one line. If no image is attached, say so.";
const ARMS = (process.env.ARMS ?? "image,agent,noimage").split(",").map((a) => a.trim());
const dataUrl = `data:image/${extname(IMAGE).slice(1).replace("jpg", "jpeg")};base64,${readFileSync(IMAGE).toString("base64")}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
for (const arm of ARMS) {
  const s = new ModelSession();
  const t0 = Date.now();
  let answer = "", err = null, result = null;
  try {
    const stream = await s.run(QUESTION, MODEL, undefined, arm === "agent", arm === "noimage" ? [] : [dataUrl]);
    for await (const d of stream) answer += d;
    if (stream.fullText && stream.fullText.length > answer.length) answer = stream.fullText;
    result = stream.result?.value ?? null;
  } catch (e) {
    err = e.message;
  }
  const hits = EXPECT.filter((w) => answer.toLowerCase().includes(w));
  rows.push({ arm, hits: `${hits.length}/${EXPECT.length}`, secs: Math.round((Date.now() - t0) / 1000), result, err });
  console.log(`${arm.padEnd(8)} ${hits.length}/${EXPECT.length} expected  ${result ?? ""} ${err ?? ""}\n  ${JSON.stringify(answer.trim().slice(0, 300))}`);
  if (result === "Throttled") break;
  await pause(20_000);
}
console.log("\n=== SUMMARY ===");
for (const r of rows) console.log(`${r.arm.padEnd(8)} ${r.hits} (${r.secs}s)${r.err ? " ERROR " + r.err : ""}`);
