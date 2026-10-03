#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { generateOpenClawConfig, startForOpenClaw } from "./index.js";
import { getToken, createLogger } from "@m365-copilot/core";

const log = createLogger("openclaw-setup");

const OPENCLAW_CONFIG_DIR = join(homedir(), ".openclaw");
const OPENCLAW_CONFIG_FILE = join(OPENCLAW_CONFIG_DIR, "openclaw.json");

const args = process.argv.slice(2);
const startFlag = args.includes("--start");
const portArg = args.find(a => /^\d+$/.test(a));
const PORT = parseInt(portArg || "4141", 10);

async function main() {
  console.log("M365 Copilot → OpenClaw Setup");
  console.log("==============================\n");

  // Step 1: Verify M365 auth
  console.log("1. Checking M365 authentication...");
  try {
    await getToken();
    console.log("   Auth OK\n");
  } catch (err: any) {
    console.error(`   Auth failed: ${err.message}`);
    console.error("   Set up credentials in ~/.config/opencode-m365/secrets.json first.");
    process.exit(1);
  }

  // Step 2: Generate config
  console.log(`2. Generating OpenClaw config (proxy port: ${PORT})...`);
  const config = generateOpenClawConfig(PORT);

  // Step 3: Merge into existing config or create new
  mkdirSync(OPENCLAW_CONFIG_DIR, { recursive: true });

  let existing: any = {};
  if (existsSync(OPENCLAW_CONFIG_FILE)) {
    try {
      existing = JSON.parse(readFileSync(OPENCLAW_CONFIG_FILE, "utf-8"));
      console.log("   Found existing openclaw.json, merging...");
    } catch {
      console.log("   Existing openclaw.json is invalid, creating new...");
    }
  } else {
    console.log("   Creating new openclaw.json...");
  }

  // Deep merge: add m365 provider without removing existing providers
  if (!existing.models) existing.models = {};
  existing.models.mode = "merge";
  if (!existing.models.providers) existing.models.providers = {};
  existing.models.providers.m365 = config.models.providers.m365;

  if (!existing.agents) existing.agents = {};
  if (!existing.agents.defaults) existing.agents.defaults = {};
  if (!existing.agents.defaults.models) existing.agents.defaults.models = {};
  Object.assign(existing.agents.defaults.models, config.agents.defaults.models);

  writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(existing, null, 2) + "\n");
  console.log(`   Written to ${OPENCLAW_CONFIG_FILE}\n`);

  // Step 4: Install skill
  const skillSrc = join(import.meta.dirname, "..", "skill");
  const skillDest = join(OPENCLAW_CONFIG_DIR, "skills", "m365-copilot");
  if (existsSync(join(skillSrc, "SKILL.md"))) {
    mkdirSync(skillDest, { recursive: true });
    const skillContent = readFileSync(join(skillSrc, "SKILL.md"), "utf-8");
    writeFileSync(join(skillDest, "SKILL.md"), skillContent);
    console.log(`3. Installed skill to ${skillDest}\n`);
  } else {
    console.log("3. Skill file not found, skipping skill install\n");
  }

  // Step 5: Print usage or start proxy
  console.log("Available models:");
  for (const model of config.models.providers.m365.models) {
    const reasoning = model.reasoning ? " (reasoning)" : "";
    console.log(`  - m365/${model.id}: ${model.name}${reasoning}`);
  }

  if (startFlag) {
    console.log(`\n4. Starting proxy on port ${PORT}...\n`);
    const { proxy } = await startForOpenClaw({ port: PORT });
    console.log(`M365 Copilot proxy listening on http://localhost:${proxy.port}`);
    console.log("Press Ctrl+C to stop.\n");
    // Keep process alive
    process.on("SIGINT", async () => {
      await proxy.close();
      process.exit(0);
    });
  } else {
    console.log("\nSetup complete! To use M365 Copilot with OpenClaw:\n");
    console.log(`  1. Start the proxy:  m365-proxy ${PORT}  (or: m365-openclaw-setup --start)`);
    console.log("  2. Start OpenClaw:   openclaw");
    console.log("  3. Select model:     m365/m365-copilot (or any m365/* model)\n");
    console.log("Apply config: openclaw gateway config.apply --file ~/.openclaw/openclaw.json");
  }
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
