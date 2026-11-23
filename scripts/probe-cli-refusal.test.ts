import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function run(script: string, args: string[] = [], refuseAt = 3) {
  const dir = mkdtempSync(join(tmpdir(), "probe-cli-"));
  const loader = join(dir, "loader.mjs");
  const core = `export const getToken=async()=>"synthetic"; export const decodeJwt=()=>({}); export const getOrCreateAgent=async()=>"agent"; export const getTransport=()=>"chathub"; export const getStreamHubScenario=()=>"test"; export const formatMessages=()=>"task";`;
  const probe = `let n=0; export async function oneTurn(o) { n++; if (n === ${refuseAt}) return {attempted:false,error:"local refusal"}; if (n > (o.maxAttempts ?? 20)) return {attempted:false,error:"cap"}; return {attempted:true,fullText:"BANANA7 ZEBRA9 1 2 3",transport:"chathub",scores:{},elapsedMs:1,throttle:null}; }`;
  writeFileSync(loader, `const core=${JSON.stringify("data:text/javascript," + encodeURIComponent(core))}; const probe=${JSON.stringify("data:text/javascript," + encodeURIComponent(probe))}; export async function resolve(s,c,next) { if(s.endsWith('/core/dist/index.mjs')) return {url:core,shortCircuit:true}; if(s.endsWith('/_probe-chat.mjs')) return {url:probe,shortCircuit:true}; return next(s,c); }`);
  const fast = join(dir, "fast.mjs");
  writeFileSync(fast, "globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };\n");
  const stdout = execFileSync(process.execPath, ["--no-warnings", "--import", pathToFileURL(fast).href, "--experimental-loader", pathToFileURL(loader).href, join(root, "scripts", script), ...args], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir }, encoding: "utf8", timeout: 15000 });
  return { dir, stdout };
}

function results(dir: string, folder: string) {
  const base = join(dir, "scripts", folder);
  return JSON.parse(readFileSync(join(base, readdirSync(base)[0], "results.json"), "utf8"));
}

describe("probe CLI local refusal", () => {
  it("preserves completed input-size rungs", () => {
    const {dir} = run("input-size-bisect.mjs", ["--ladder", "10,20,30,40"]);
    expect(results(dir, "input-size-out").results).toHaveLength(2);
  });
  it("preserves completed output-ceiling rungs", () => {
    const {dir} = run("output-ceiling-probe.mjs");
    expect(results(dir, "output-ceiling-out").results).toHaveLength(2);
  });
  it("preserves completed native-tool cells", () => {
    const {dir} = run("sonnet5-native-tools-probe.mjs", ["pwd-proxy,pwd-none,pwd-codeonly,pwd-imageonly"]);
    expect(results(dir, "tone-out")).toHaveLength(2);
  });
  it("budgets all 21 turns for six repeats across default tones", () => {
    const {stdout} = run("claude-tools-probe.mjs", ["6"], 1000);
    expect(stdout).toContain("VIABLE Claude-for-tools");
  });
});
