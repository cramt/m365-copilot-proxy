import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./codex-catalog.mjs", import.meta.url));
const template = {
  slug: "m365/claude-sonnet",
  display_name: "M365 Claude Sonnet",
  context_window: 256000,
  prefer_websockets: false,
  tool_mode: "code_mode_only",
};

async function run(args, data, models = [template]) {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url.startsWith("/v1/models") ? { data } : { models }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await exec(process.execPath, [script, `--gateway=http://127.0.0.1:${server.address().port}`, ...args]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("codex-catalog", () => {
  it("includes every discovered model, even when the Codex catalog omits it", async () => {
    const data = [
      { id: "m365/gpt-6.1-sol", name: "GPT-6.1 Sol", input_modalities: ["text", "image"] },
      { id: template.slug },
      { id: "m365/gpt-6.1-sol" },
    ];
    const { stdout } = await run(["--all", "--window=1000000"], data);
    const { models } = JSON.parse(stdout);
    expect(models.map((model) => model.slug)).toEqual(["m365/gpt-6.1-sol", template.slug]);
    expect(models[0]).toMatchObject({
      display_name: "GPT-6.1 Sol",
      input_modalities: ["text", "image"],
      visibility: "list",
      context_window: 1000000,
      max_context_window: 1000000,
      priority: 1,
      tool_mode: "code_mode_only",
      prefer_websockets: false,
    });
    expect(models.some((model) => model.slug.includes("6.2"))).toBe(false);
  });

  it("preserves explicit ordering and per-model context windows with discovery fallback", async () => {
    const { stdout } = await run(
      [`${template.slug}=500000`, "m365/gpt-6.1-sol=1000000"],
      [{ id: "m365/gpt-6.1-sol", name: "GPT-6.1 Sol", input_modalities: ["text", "image"] }],
    );
    const { models } = JSON.parse(stdout);
    expect(models.map((model) => model.slug)).toEqual([template.slug, "m365/gpt-6.1-sol"]);
    expect(models.map((model) => model.context_window)).toEqual([500000, 1000000]);
    expect(models[0].display_name).toBe(template.display_name);
    expect(models[1]).toMatchObject({ display_name: "GPT-6.1 Sol", input_modalities: ["text", "image"] });
  });

  it("rejects names the gateway does not advertise instead of manufacturing routes", async () => {
    await expect(run(["m365/gpt-6.2-astra"], [{ id: template.slug }])).rejects.toMatchObject({
      stderr: expect.stringContaining("isn't in the gateway's Codex catalog or model discovery"),
    });
  });

  it("rejects an empty discovery list rather than replacing the picker with an empty catalog", async () => {
    await expect(run(["--all"], [])).rejects.toMatchObject({
      stderr: expect.stringContaining("didn't advertise any models"),
    });
  });

  it("rejects invalid per-model context windows", async () => {
    await expect(run([`${template.slug}=invalid`], [])).rejects.toMatchObject({
      stderr: expect.stringContaining("context window must be a positive number"),
    });
  });
});
