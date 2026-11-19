import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./codex-catalog.mjs", import.meta.url));
const claude = {
  slug: "m365/claude-sonnet",
  display_name: "M365 Claude Sonnet",
  context_window: 256000,
  prefer_websockets: false,
  tool_mode: "code_mode_only",
};
// copilot-api copies an upstream model's entry, window included, for a provider model of the same name.
const gpt = { slug: "m365/gpt-6.1-sol", display_name: "GPT-6.1 Sol (m365)", context_window: 272000 };
const upstreamOnly = { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", context_window: 272000 };
const catalog = [upstreamOnly, gpt, claude];

async function run(args, { data = [], models = catalog, rawDiscovery } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request);
    const discovery = request.url.startsWith("/v1/models");
    response.end(discovery && rawDiscovery !== undefined ? rawDiscovery : JSON.stringify(discovery ? { data } : { models }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const gateway = `--gateway=http://127.0.0.1:${server.address().port}`;
    return { ...(await exec(process.execPath, [script, gateway, ...args])), requests };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Each case runs the script as a child process, several in a row: slow under a full parallel run.
describe("codex-catalog", { timeout: 30_000 }, () => {
  it("--all lists the advertised models the uncapped Codex catalog offers, with the gateway's windows", async () => {
    const data = [
      { id: gpt.slug, context_window: 1000000 },
      { id: "text-embedding-3-small", context_window: 8192 },
      null,
      { id: claude.slug },
      { id: gpt.slug },
    ];
    const { stdout, stderr, requests } = await run(["--all"], { data });
    const { models } = JSON.parse(stdout);
    expect(models.map((model) => model.slug)).toEqual([gpt.slug, claude.slug]);
    expect(models.map((model) => [model.context_window, model.max_context_window, model.priority])).toEqual([
      [1000000, 1000000, 1],
      [256000, 256000, 2],
    ]);
    expect(models[1]).toMatchObject({ ...claude, visibility: "list" });
    expect(stderr).toContain("skipped, not in the gateway's Codex catalog: text-embedding-3-small");
    const catalogRequest = requests.find((request) => request.url.startsWith("/models"));
    expect(catalogRequest.headers).toMatchObject({ "x-full-model-catalog": "true", "user-agent": "codex_cli_rs/0.169.0" });
  });

  it("--all applies --window to every model and MODEL=WINDOW to one", async () => {
    const data = [{ id: gpt.slug, context_window: 1000000 }, { id: claude.slug }];
    const { stdout } = await run(["--all", "--window=400000", `${claude.slug}=450000`], { data });
    expect(JSON.parse(stdout).models.map((model) => model.context_window)).toEqual([400000, 450000]);
  });

  it("keeps the given order for named models and gives them --window unless they set their own", async () => {
    const { stdout, requests } = await run([`${claude.slug}=500000`, gpt.slug, upstreamOnly.slug]);
    const { models } = JSON.parse(stdout);
    expect(models.map((model) => model.slug)).toEqual([claude.slug, gpt.slug, upstreamOnly.slug]);
    expect(models.map((model) => model.context_window)).toEqual([500000, 1000000, 1000000]);
    expect(requests.some((request) => request.url.startsWith("/v1/models"))).toBe(false);
  });

  it("rejects models the Codex catalog doesn't offer instead of manufacturing entries", async () => {
    await expect(run(["m365/gpt-6.2-astra"])).rejects.toMatchObject({
      stderr: expect.stringContaining("m365/gpt-6.2-astra isn't in copilot-api's Codex catalog"),
    });
    await expect(run(["--all", "text-embedding-3-small=8192"], { data: [{ id: "text-embedding-3-small" }, { id: gpt.slug }] }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("text-embedding-3-small isn't one of the gateway's Codex models") });
    await expect(run(["--all"], { data: [{ id: "text-embedding-3-small" }] })).rejects.toMatchObject({
      stderr: expect.stringContaining("didn't advertise any model its Codex catalog offers"),
    });
  });

  it("rejects context windows that aren't positive integers", async () => {
    for (const window of ["invalid", "250000.5", "1e21", "0", ""]) {
      await expect(run([`${claude.slug}=${window}`])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("context window must be a positive integer"),
      });
    }
    await expect(run(["--window=1.5", claude.slug])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("usage:") });
    await expect(run(["--all", claude.slug])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("usage:") });
  });

  it("exits with a one-line reason when the gateway is down or doesn't answer JSON", async () => {
    for (const rawDiscovery of ["<html>Bad Gateway</html>", "null"]) {
      const error = await run(["--all"], { rawDiscovery }).catch((e) => e);
      expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining("/v1/models didn't return a model list") });
      expect(error.stderr).not.toContain("    at ");
    }
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    const error = await exec(process.execPath, [script, `--gateway=http://127.0.0.1:${port}`, "--all"]).catch((e) => e);
    expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining(`127.0.0.1:${port}/models: ECONNREFUSED`) });
    expect(error.stderr).not.toContain("    at ");
  });
});
