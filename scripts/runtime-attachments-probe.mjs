// Discover attachment routes; --verify spends two sequential runtime turns on synthetic files.
// Usage: M365_AUTH_MODE=wam node scripts/runtime-attachments-probe.mjs
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { getTokenForScope, AETHER_SCOPE, containerConfig, sseEvents } from "../packages/core/dist/index.mjs";

async function fixtures() {
  const require = createRequire(new URL("../packages/core/package.json", import.meta.url));
  const { chromium } = require("playwright");
  const JSZip = createRequire(require.resolve("selenium-webdriver"))("jszip");
  const codes = Array.from({ length: 5 }, () => randomUUID().slice(0, 8).toUpperCase());
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
  });
  let png, pdf;
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 180 } });
    await page.setContent(`<body style="background:white;color:black;font:40px monospace">Validation code: ${codes[0]}</body>`);
    png = await page.screenshot();
    await page.setContent(`<body>Validation code: ${codes[2]}</body>`);
    pdf = await page.pdf();
  } finally {
    await browser.close();
  }
  const word = new JSZip();
  word.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  word.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  word.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Validation code: ${codes[3]}</w:t></w:r></w:p></w:body></w:document>`);
  const excel = new JSZip();
  excel.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  excel.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  excel.file("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Probe" sheetId="1" r:id="rId1"/></sheets></workbook>');
  excel.file("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  excel.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Validation code: ${codes[4]}</t></is></c></row></sheetData></worksheet>`);
  const values = [
    ["probe.png", "image/png", png],
    ["probe.txt", "text/plain", Buffer.from(`Validation code: ${codes[1]}`)],
    ["probe.pdf", "application/pdf", pdf],
    ["probe.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await word.generateAsync({ type: "nodebuffer" })],
    ["probe.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await excel.generateAsync({ type: "nodebuffer" })],
  ];
  return values.map(([name, type, bytes], i) => ({ name, type, bytes, code: codes[i] }));
}

async function verify(endpoint, auth, claims) {
  const files = await fixtures();
  const model = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? "gpt-6.2-sol-substrate";
  const results = [];
  for (const mode of ["cowork", "code"]) {
    if (results.length) await new Promise((resolve) => setTimeout(resolve, 30_000));
    const key = `${mode === "code" ? "code-" : ""}${randomUUID()}`;
    const conversationId = mode === "code" ? key : `${claims.tid}:${claims.oid}:${key}`;
    const headers = {
      ...auth,
      "x-conversation-id": conversationId,
      "x-container-config": containerConfig(mode, model, "medium"),
      ...(mode === "code" ? { "x-container-type": "copilot" } : {}),
    };
    const result = { mode, model, session: key, uploads: [], answer: "", credits: 0, recovered: [] };
    try {
      const prewarm = await fetch(`${endpoint}/v1/prewarm`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(120_000),
      });
      console.log(JSON.stringify({ mode, prewarm: prewarm.status }));
      const attachments = [];
      for (const file of files) {
        const form = new FormData();
        form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
        const upload = await fetch(`${endpoint}/v1/conversations/${encodeURIComponent(conversationId)}/files?conflict=error`, {
          method: "POST", headers, body: form, signal: AbortSignal.timeout(120_000),
        });
        const body = await upload.json();
        result.uploads.push({ file: file.name, status: upload.status, bytes: file.bytes.length });
        console.log(JSON.stringify({ mode, upload: result.uploads.at(-1) }));
        if (!upload.ok || typeof body.workspace_url !== "string") throw new Error(`Upload failed: ${JSON.stringify(body)}`);
        attachments.push({ type: "attachment", workspaceUrl: body.workspace_url });
      }
      const messageId = randomUUID();
      const message = await fetch(`${endpoint}/v1/messages`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          content: [{ type: "text", text: "Read each attached file. Return each filename and the validation code shown in its content. Codes are not in the filenames. Do not guess any unreadable code." }, ...attachments],
          conversationId, messageId, queue: true, role: "user",
        }), signal: AbortSignal.timeout(120_000),
      });
      const accepted = await message.json();
      if (!message.ok || !accepted.id) throw new Error(`Message HTTP ${message.status}: ${JSON.stringify(accepted)}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180_000);
      try {
        const stream = await fetch(`${endpoint}/v1/subscribe`, {
          headers: { ...headers, accept: "text/event-stream", "last-event-id": accepted.id },
          signal: controller.signal,
        });
        if (!stream.ok || !stream.body) throw new Error(`Subscribe HTTP ${stream.status}`);
        let started = false;
        for await (const event of sseEvents(stream.body)) {
          let data;
          try { data = JSON.parse(event.data); } catch { continue; }
          if (event.event === "rl" && data.mid === messageId && data.st === "started") started = true;
          if (event.event === "cq") result.credits += Number(data.d) || 0;
          if (started && event.event === "dx" && typeof data.t === "string") result.answer += data.t;
          if (started && event.event === "fr") {
            const content = typeof data.content === "string" ? data.content : (data.content ?? []).map((c) => c.text ?? "").join("");
            result.answer += `\n${content}`;
          }
          if (event.event === "rl" && data.mid === messageId && data.st !== "started") {
            result.run = data.st;
            result.toolCalls = data.tc;
            break;
          }
        }
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
      result.recovered = files.map((file) => ({ file: file.name, code: file.code, read: result.answer.includes(file.code) }));
    } catch (error) {
      result.error = error.message;
    } finally {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const cleanup = await fetch(`${endpoint}/v1/conversations/${encodeURIComponent(key)}`, {
            method: "DELETE",
            headers: { ...auth, ...(mode === "code" ? { "x-container-type": "copilot" } : {}) },
            signal: AbortSignal.timeout(30_000),
          });
          result.cleanup = cleanup.status;
          if (cleanup.ok || cleanup.status === 404) break;
        } catch (error) {
          result.cleanupError = error.message;
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  return results.every((r) => !r.error && r.recovered.length === files.length && r.recovered.every((f) => f.read));
}

try {
  const token = await getTokenForScope([AETHER_SCOPE]);
  if (!token) throw new Error("No runtime token");
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const headers = {
    authorization: `Bearer ${token}`,
    "x-tenant-id": claims.tid,
    "x-user-id": claims.oid,
    "x-cowork-host-type": "officeweb:web",
  };
  const routing = await fetch("https://cowork.us-ia888.gateway.prod.island.powerapps.com/v1/routing", {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!routing.ok) throw new Error(`Routing HTTP ${routing.status}`);
  const { endpoint } = await routing.json();
  if (process.argv.includes("--verify")) {
    process.exit(await verify(endpoint, headers, claims) ? 0 : 1);
  }
  for (const path of ["/openapi.json", "/v1/openapi.json", "/v1/files"]) {
    const res = await fetch(`${endpoint}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    console.log(JSON.stringify({ path, status: res.status, contentType: res.headers.get("content-type") }));
    if (!res.ok && path === "/v1/files") console.log(JSON.stringify({ error: await res.json() }));
    if (!res.ok || !path.includes("openapi")) continue;
    const schema = await res.json();
    for (const [route, operations] of Object.entries(schema.paths ?? {})) {
      if (/files|upload|messages|attachment/i.test(route)) console.log(JSON.stringify({ route, operations }));
    }
    for (const [name, value] of Object.entries(schema.components?.schemas ?? {})) {
      if (/file|image|attachment|content|message/i.test(name)) console.log(JSON.stringify({ schema: name, value }));
    }
  }
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
