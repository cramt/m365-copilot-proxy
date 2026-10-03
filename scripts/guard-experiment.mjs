// Offline experiment: which "is this a document, not a tool call?" guard best
// separates content responses (a model writing a README full of ```bash fences)
// from real agentic actions (a single shell command)? No quota — pure parsing.
//
//   nix develop --command node scripts/guard-experiment.mjs
//
// Result (June 2026): H2 "≥2 fences AND prose≥120" scored 7/7 and is what
// isProseDocument() ships. See packages/core/src/tools.ts.
import { parseToolCalls } from "../packages/core/dist/index.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tools = [
  {
    type: "function",
    function: {
      name: "bash",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];
const realReadme = readFileSync(join(root, "README.md"), "utf8");
const modelReadme = `Here's a simplified README:\n\n# tool\nDoes stuff.\n\n## Install\n\`\`\`bash\npnpm install && pnpm build\n\`\`\`\n\n## Run\n\`\`\`bash\npnpm run proxy 4141\n\`\`\`\nThat covers the basics you need to get going.`;

const FIX = {
  "real-readme (CONTENT)": [realReadme, "text"],
  "model-readme (CONTENT)": [modelReadme, "text"],
  "action-sed (ACTION)": ["```bash\nsed -i 's/a - b/a + b/' calc.py\n```", "action"],
  "action-ls (ACTION)": ["```bash\nls -la\n```", "action"],
  "action-heredoc (ACTION)": ["```bash\ncat > a.py <<'EOF'\nprint(1)\nEOF\n```", "action"],
  "mixed-illustration (ACTION)": [
    "I'll inspect first.\n```bash\nls -la && cat calc.py\n```",
    "action",
  ],
  "batch-2real (ACTION)": ["```bash\nls\n```\n```bash\ncat calc.py\n```", "action"],
};
const prose = (p) => (p.textContent ? p.textContent.trim().length : 0);
const GUARDS = {
  baseline: (p) => (p.hasToolCalls ? "action" : "text"),
  "H1_count>=3": (p) =>
    p.hasToolCalls && p.toolCalls.length >= 3 ? "text" : p.hasToolCalls ? "action" : "text",
  "H2_2fence+prose": (p) =>
    p.hasToolCalls && p.toolCalls.length >= 2 && (prose(p) >= 120 || p.toolCalls.length >= 4)
      ? "text"
      : p.hasToolCalls
        ? "action"
        : "text",
  "H3_prose>=200": (p) =>
    p.hasToolCalls && prose(p) >= 200 ? "text" : p.hasToolCalls ? "action" : "text",
};
const names = Object.keys(GUARDS);
const score = Object.fromEntries(names.map((n) => [n, 0]));
console.log("fixture".padEnd(28), "fences", names.map((n) => n.padEnd(18)).join(""));
for (const [name, [t, want]] of Object.entries(FIX)) {
  const p = parseToolCalls(t, tools);
  const row = names.map((n) => {
    const got = GUARDS[n](p);
    if (got === want) score[n]++;
    return ((got === want ? "✓" : "✗") + got).padEnd(18);
  });
  console.log(name.padEnd(28), String(p.toolCalls.length).padEnd(6), row.join(""));
}
console.log("\nscore:", names.map((n) => `${n}=${score[n]}/${Object.keys(FIX).length}`).join("  "));
