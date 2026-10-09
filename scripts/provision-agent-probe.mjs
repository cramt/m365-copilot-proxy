// One-shot: exercise the FULL agent provisioning (env discovery → create → publish)
// against the real tenant. Prints the resulting agentId (or null) and relies on
// M365_DEBUG=1 to log each step to ~/.config/m365-proxy/debug.log.
// Usage: M365_NO_INTERACTIVE=1 node scripts/provision-agent-probe.mjs
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

import { getOrCreateAgent } from "../packages/core/dist/index.mjs";

const agentId = await getOrCreateAgent({ forceRefresh: true });
console.log("\n[probe] getOrCreateAgent ->", agentId);
process.exit(agentId ? 0 : 1);
