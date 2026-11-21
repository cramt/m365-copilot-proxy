import { getToken, decodeJwt } from "../../packages/core/dist/index.mjs";
import { oneTurn as defaultOneTurn } from "../_probe-chat.mjs";

import { resolve as resolveEntrypoint } from "node:path";
import { pathToFileURL as entrypointURL } from "node:url";

export async function main({ oneTurn = defaultOneTurn } = {}) {
const token = await getToken(); const claims = decodeJwt(token);
const tones = process.argv.slice(2).length ? process.argv.slice(2) : ["Claude_Fable", "Claude_Fable_Reasoning", "Gpt_5_5_Auto"];
for (const tone of tones) {
  const r = await oneTurn({ token, claims, tone, text: "Which AI model are you exactly? State your model name and the company that made you in one short sentence. Do not add anything else.", timeoutMs: 60000 });
    if (r.attempted === false) throw new Error(`Probe not attempted: ${r.error}`);
  console.log(`\n[${tone}] transport=${r.transport} disengaged=${r.disengaged} types=${r.messageTypes.join(",")} err=${r.error ?? "none"}`);
  console.log(`[${tone}] → ${JSON.stringify((r.fullText||"").slice(0,220))}`);
}

}

if (process.argv[1] && import.meta.url === entrypointURL(resolveEntrypoint(process.argv[1])).href) await main();
