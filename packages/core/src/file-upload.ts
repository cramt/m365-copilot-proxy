import { randomUUID } from "node:crypto";
import { getTokenForScope } from "./auth.js";
import { createLogger } from "./log.js";
import type { Message } from "./tools.js";

const log = createLogger("file-upload");

// Document input. The web client doesn't send a document to UploadFile the way it
// does an image (image-input.ts): it puts the file in the user's OneDrive, in the
// "Microsoft Copilot Chat Files" special folder, and points the chat message at it
// with a `LocalFile` annotation (captured 2026-10-16 from the web UI):
//
//   POST graph /me/drive/special/copilotuploads:/<name>:/createUploadSession
//   PUT  <uploadUrl>                         (the bytes)
//   messageAnnotations: [{ id: "SPO_<base64 siteId,webId,listId>_<itemId>",
//                          text: <name>, url: <webUrl>, messageAnnotationType: "LocalFile" }]
//
// The proxy's own client is the web client's, and its Graph token carries
// Files.ReadWrite.All, so the same upload works silently from the cached login.
const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];
// Upload-session chunks must be multiples of 320 KiB.
const CHUNK = 320 * 1024 * 20;

export interface FileAnnotation {
  id: string;
  text: string;
  url: string;
  messageAnnotationType: "LocalFile";
}

interface ParsedDataUrl {
  mime: string;
  name?: string;
  bytes: Buffer;
}

/** `data:<mime>[;name=<file name>];base64,<data>` — `name` is how a file part's
 *  filename rides along with the data URL (see attachmentUrls). */
export function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const m = /^data:([^;,]+)((?:;[^;,]*)*);base64,/i.exec(dataUrl);
  if (!m) throw new Error("not a base64 data URL");
  const name = /;name=([^;,]*)/i.exec(m[2])?.[1];
  return {
    mime: m[1].toLowerCase(),
    name: name ? decodeURIComponent(name) : undefined,
    bytes: Buffer.from(dataUrl.slice(m[0].length), "base64"),
  };
}

const EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** A name OneDrive accepts: no path, none of its reserved characters. */
function safeName(name: string | undefined, mime: string): string {
  const base = (name ?? "").split(/[\\/]/).pop()!.replace(/["*:<>?|#%]/g, "_").trim();
  return base || `file-${randomUUID().slice(0, 8)}.${EXT[mime] ?? "bin"}`;
}

/** The annotation id the web client sends: the file's SharePoint ids, base64
 *  without padding, then the drive item id. */
export function spoId(ids: { siteId: string; webId: string; listId: string }, itemId: string): string {
  const b64 = Buffer.from(`${ids.siteId},${ids.webId},${ids.listId}`).toString("base64").replace(/=+$/, "");
  return `SPO_${b64}_${itemId}`;
}

/** Upload one document (a base64 data URL) to the Copilot Chat Files folder and
 *  return the annotation that attaches it to a chat message. */
export async function uploadFile(dataUrl: string, token?: string): Promise<FileAnnotation> {
  const { mime, name: rawName, bytes } = parseDataUrl(dataUrl);
  if (bytes.length === 0) throw new Error("empty file");
  const name = safeName(rawName, mime);
  token ??= (await getTokenForScope(GRAPH_SCOPES)) ?? undefined;
  if (!token) throw new Error("no Graph token");
  const auth = { Authorization: `Bearer ${token}` };

  const res = await fetch(`${GRAPH}/me/drive/special/copilotuploads:/${encodeURIComponent(name)}:/createUploadSession`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Prefer: "ExtractTextOnCommit" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace", name } }),
  });
  if (!res.ok) throw new Error(`createUploadSession ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { uploadUrl } = (await res.json()) as { uploadUrl?: string };
  if (!uploadUrl) throw new Error("createUploadSession returned no uploadUrl");

  // The upload URL is pre-authorized; it takes no bearer token.
  let item: any;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const chunk = bytes.subarray(start, start + CHUNK);
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes ${start}-${start + chunk.length - 1}/${bytes.length}` },
      body: new Uint8Array(chunk),
    });
    if (!put.ok) throw new Error(`upload PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
    if (put.status === 200 || put.status === 201) item = await put.json();
  }
  if (!item?.id) throw new Error("upload finished without a drive item");

  const meta = await fetch(`${GRAPH}/me/drive/items/${item.id}?$select=id,name,webUrl,sharepointIds`, { headers: auth });
  if (!meta.ok) throw new Error(`drive item ${meta.status}: ${(await meta.text()).slice(0, 200)}`);
  const { webUrl, sharepointIds } = (await meta.json()) as { webUrl: string; sharepointIds: { siteId: string; webId: string; listId: string } };
  log.info(`Uploaded ${name} (${bytes.length} bytes, ${mime}) → ${item.id}`);
  return { id: spoId(sharepointIds, item.id), text: name, url: webUrl, messageAnnotationType: "LocalFile" };
}

/** The attachments in these messages, in order, as data URLs: OpenAI `image_url`
 *  parts as they are, and `file` parts with their filename folded in as `;name=`. */
export function attachmentUrls(messages: Message[]): string[] {
  return messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.flatMap((p) => {
          if (p.type === "image_url" && typeof p.image_url?.url === "string") return [p.image_url.url];
          const data = p.type === "file" ? p.file?.file_data : undefined;
          if (typeof data !== "string" || !data.startsWith("data:")) return [];
          return [p.file?.filename ? data.replace(/^(data:[^;,]+)/, `$1;name=${encodeURIComponent(p.file.filename)}`) : data];
        })
      : [],
  );
}
