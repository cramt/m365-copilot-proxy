// The selector probe's offline parts: reading the selector items out of a
// RefreshNavPane reply, the table it prints, and the request it sends. No network.
import { describe, expect, it } from "vitest";
import { APP_SHELL_ACTION_URL, formatTable, requestNavPane, selectorItems, selectorOptions } from "./chathub-tones.mjs";

const selector = (availableModelSelectionOptions) => ({
  clientPreferences: { modelSelectorMetadata: { defaultModelSelectionId: "Magic", availableModelSelectionOptions } },
});

describe("selectorItems", () => {
  it("reads items and itemGroup members from both stores, sorted by tone, each pair once", () => {
    const reply = {
      store: {
        bizchatAsAgentGpt: selector([
          { type: "item", id: "Magic", menuItemTitle: "Auto" },
          {
            type: "itemGroup", id: "Claude", menuItemTitle: "Claude",
            itemGroup: [
              { type: "item", id: "Claude_Sonnet", menuItemTitle: "Sonnet 5.5" },
              { type: "item", id: "Claude_Opus", menuItemTitle: "Opus 5.5" },
              { type: "divider", id: "Not_An_Item", menuItemTitle: "-" },
            ],
          },
        ]),
        bizchatAsAgentGptWebTab: selector([
          { type: "item", id: "Magic", menuItemTitle: "Auto" },
          { type: "itemGroup", id: "OpenAI", menuItemTitle: "GPT", itemGroup: [{ type: "item", id: "Gpt_5_6_Chat", menuItemTitle: "GPT-5.6 Sol Quick response" }] },
        ]),
        agentList: [selector([{ type: "item", id: "Agent_Only", menuItemTitle: "Read by neither store" }])],
      },
    };
    expect(selectorItems(reply)).toEqual([
      { tone: "Claude_Opus", title: "Opus 5.5" },
      { tone: "Claude_Sonnet", title: "Sonnet 5.5" },
      { tone: "Gpt_5_6_Chat", title: "GPT-5.6 Sol Quick response" },
      { tone: "Magic", title: "Auto" },
    ]);
  });

  it("keeps an item that is also a group, as the jq filter does", () => {
    const reply = {
      store: {
        bizchatAsAgentGpt: selector([
          { type: "item", id: "Parent", menuItemTitle: "P", itemGroup: [{ type: "item", id: "Child", menuItemTitle: "C" }] },
        ]),
      },
    };
    expect(selectorItems(reply)).toEqual([{ tone: "Child", title: "C" }, { tone: "Parent", title: "P" }]);
  });

  it("keeps one tone under two titles as two rows, ordered by title", () => {
    const reply = {
      store: {
        bizchatAsAgentGpt: selector([{ type: "item", id: "Chat", menuItemTitle: "Quick response" }]),
        bizchatAsAgentGptWebTab: selector([{ type: "item", id: "Chat", menuItemTitle: "Fast" }]),
      },
    };
    expect(selectorItems(reply)).toEqual([{ tone: "Chat", title: "Fast" }, { tone: "Chat", title: "Quick response" }]);
  });

  it("reads what one store has when the other is missing, and nothing from a reply without either", () => {
    const one = { store: { bizchatAsAgentGptWebTab: selector([{ type: "item", id: "Chat", menuItemTitle: "Quick response" }]) } };
    expect(selectorOptions(one, "bizchatAsAgentGpt")).toBeNull();
    expect(selectorItems(one)).toEqual([{ tone: "Chat", title: "Quick response" }]);
    expect(selectorItems({ store: { notebooks: { errorMessage: "HTTP 401: " } } })).toEqual([]);
    expect(selectorItems(null)).toEqual([]);
  });

  it("skips an item without a string id and gives an item without a title an empty one", () => {
    const reply = { store: { bizchatAsAgentGpt: selector([{ type: "item", menuItemTitle: "No id" }, { type: "item", id: "Bare" }]) } };
    expect(selectorItems(reply)).toEqual([{ tone: "Bare", title: "" }]);
  });
});

describe("formatTable", () => {
  it("prints a Markdown table with Tone and Title columns, padded to the widest cell", () => {
    const table = formatTable([
      { tone: "Claude_Opus", title: "Opus 5.5" },
      { tone: "Gpt_5_6_Chat", title: "GPT-5.6 Sol Quick response" },
    ]);
    expect(table.split("\n")).toEqual([
      "| Tone         | Title                      |",
      "|--------------|----------------------------|",
      "| Claude_Opus  | Opus 5.5                   |",
      "| Gpt_5_6_Chat | GPT-5.6 Sol Quick response |",
    ]);
  });

  it("is as wide as the header when the cells are narrower", () => {
    expect(formatTable([{ tone: "X", title: "" }]).split("\n")).toEqual([
      "| Tone | Title |",
      "|------|-------|",
      "| X    |       |",
    ]);
  });

  it("escapes a pipe and turns a line break into a space, so a cell stays in its column", () => {
    expect(formatTable([{ tone: "A|B", title: "two\nlines" }]).split("\n")).toEqual([
      "| Tone | Title     |",
      "|------|-----------|",
      "| A\\|B | two lines |",
    ]);
  });
});

describe("requestNavPane", () => {
  const response = (status, headers, body = "") => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => body,
  });

  it("POSTs the RefreshNavPane action with the bearer token and asks for JSON", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return response(200, { "content-type": "application/json; charset=utf-8" }, '{"store":{}}');
    };
    await expect(requestNavPane("tok", fetchImpl)).resolves.toBe('{"store":{}}');
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe(APP_SHELL_ACTION_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok", accept: "application/json", "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ action: "RefreshNavPane" });
  });

  it("names the sign-in page a redirect points to, without its query", async () => {
    const fetchImpl = async () => response(302, { location: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&nonce=y" });
    await expect(requestNavPane("tok", fetchImpl)).rejects.toThrow(
      /^HTTP 302 to https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize: the server did not accept the token$/,
    );
  });

  it("refuses the app's HTML page and HTTP errors", async () => {
    const html = async () => response(200, { "content-type": "text/html; charset=utf-8" }, "<html><title>M365 Copilot</title></html>");
    await expect(requestNavPane("tok", html)).rejects.toThrow(/HTTP 200 with text\/html; charset=utf-8, not JSON \(40 bytes\)/);
    const error = async () => response(500, { "content-type": "application/json" }, '{"error":"boom"}');
    await expect(requestNavPane("tok", error)).rejects.toThrow('HTTP 500 (application/json): {"error":"boom"}');
  });
});
