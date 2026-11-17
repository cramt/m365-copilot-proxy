import { describe, it, expect, vi, afterEach } from "vitest";
import { uploadFile, attachmentUrls, parseDataUrl, spoId } from "./file-upload.js";

afterEach(() => vi.unstubAllGlobals());

const IDS = {
  siteId: "11111111-1111-4111-8111-111111111111",
  webId: "22222222-2222-4222-8222-222222222222",
  listId: "33333333-3333-4333-8333-333333333333",
};

describe("spoId", () => {
  it("encodes the SharePoint ids the way the web client does: base64 without padding, then the item id", () => {
    expect(spoId(IDS, "01TESTITEMID0000000000000000000000")).toBe(
      "SPO_MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLDIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMiwzMzMzMzMzMy0zMzMzLTQzMzMtODMzMy0zMzMzMzMzMzMzMzM_01TESTITEMID0000000000000000000000",
    );
  });
});

describe("parseDataUrl", () => {
  it("reads the type, the folded-in name, and the bytes", () => {
    const p = parseDataUrl(`data:application/pdf;name=${encodeURIComponent("仕様 v2.pdf")};base64,JVBERi0=`);
    expect(p).toMatchObject({ mime: "application/pdf", name: "仕様 v2.pdf" });
    expect(p.bytes.toString()).toBe("%PDF-");
    expect(() => parseDataUrl("https://example.com/a.pdf")).toThrow("data URL");
  });
});

describe("uploadFile", () => {
  it("uploads to copilotuploads and returns a LocalFile annotation", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("createUploadSession")) return Response.json({ uploadUrl: "https://sp.example/upload?guid=1" });
      if (url.startsWith("https://sp.example/upload")) return Response.json({ id: "ITEM1" }, { status: 201 });
      return Response.json({ id: "ITEM1", webUrl: "https://t-my.sharepoint.com/a/b.pdf", sharepointIds: IDS });
    });
    vi.stubGlobal("fetch", fetch);
    const a = await uploadFile("data:application/pdf;name=b.pdf;base64,JVBERi0=", "tok");
    const [createUrl, createInit] = fetch.mock.calls[0];
    expect(createUrl).toBe("https://graph.microsoft.com/v1.0/me/drive/special/copilotuploads:/b.pdf:/createUploadSession");
    expect((createInit!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const [, putInit] = fetch.mock.calls[1];
    expect((putInit!.headers as Record<string, string>)["Content-Range"]).toBe("bytes 0-4/5");
    expect((putInit!.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(a).toEqual({ id: spoId(IDS, "ITEM1"), text: "b.pdf", url: "https://t-my.sharepoint.com/a/b.pdf", messageAnnotationType: "LocalFile" });
  });

  it("fails loudly when Graph refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    await expect(uploadFile("data:text/plain;base64,aGk=", "tok")).rejects.toThrow("createUploadSession 403");
  });
});

describe("attachmentUrls", () => {
  it("collects image and file parts in order, with the file's name folded in", () => {
    expect(attachmentUrls([
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,A" } }] },
      { role: "user", content: [{ type: "text", text: "spec" }, { type: "file", file: { filename: "a b.pdf", file_data: "data:application/pdf;base64,B" } }] },
      { role: "user", content: [{ type: "file", file: { file_data: "data:text/plain;base64,C" } }, { type: "file", file: { file_id: "file-1" } as any }] },
    ])).toEqual(["data:image/png;base64,A", "data:application/pdf;name=a%20b.pdf;base64,B", "data:text/plain;base64,C"]);
  });
});
