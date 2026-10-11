import assert from "node:assert/strict";
import { describe, it, expect } from "vitest";
import {
  parseActionConfirmation,
  buildResumeInvokeAction,
  shouldAutoConfirm,
  ACTION_ALLOWED_MESSAGE_TYPES,
} from "./native-actions.js";

// A confirmation-trigger frame shaped like the decompiled client's, carrying an
// adaptive card whose Allow button holds {actionId, confirmationOption}.
const triggerMsg = {
  author: "bot",
  messageType: "ConfirmationCard",
  layout: "confirmation_trigger",
  actionId: "act_123",
  sourceRequestId: "req_abc",
  isConsequential: false,
  adaptiveCards: [
    {
      actions: [
        {
          type: "Action.Submit",
          title: "Cancel",
          data: { message: { actionId: "act_123", confirmationOption: "decline" } },
        },
        {
          type: "Action.Submit",
          title: "Allow",
          data: { message: { actionId: "act_123", confirmationOption: "confirm" } },
        },
      ],
    },
  ],
};

describe("parseActionConfirmation", () => {
  it("detects a confirmation trigger and extracts action fields", () => {
    const c = parseActionConfirmation(triggerMsg);
    assert(c !== null, "Expected a confirmation trigger");
    expect(c.actionId).toBe("act_123");
    expect(c.sourceRequestId).toBe("req_abc");
    expect(c.isConsequential).toBe(false);
    expect(c.confirmationOption).toBe("confirm"); // affirmative, not "decline"
  });

  it("ignores ordinary bot chat messages", () => {
    expect(
      parseActionConfirmation({ author: "bot", messageType: "Chat", text: "hello" }),
    ).toBeNull();
    expect(parseActionConfirmation({ author: "bot", text: "plain" })).toBeNull();
    expect(parseActionConfirmation(null)).toBeNull();
    expect(parseActionConfirmation(undefined)).toBeNull();
  });

  it("detects via adaptive-card actionId even without a confirm messageType", () => {
    const c = parseActionConfirmation({
      author: "bot",
      adaptiveCards: [
        {
          actions: [
            {
              type: "Action.Submit",
              title: "Allow",
              data: { message: { actionId: "x9", confirmationOption: "confirm" } },
            },
          ],
        },
      ],
    });
    expect(c?.actionId).toBe("x9");
  });

  it("falls back to requestId/messageId for sourceRequestId", () => {
    const c = parseActionConfirmation({
      messageType: "TriggerConfirmation",
      actionId: "a",
      messageId: "mid1",
      adaptiveCards: [],
    });
    expect(c?.sourceRequestId).toBe("mid1");
  });

  it("defaults isConsequential to true when absent (safe default)", () => {
    const c = parseActionConfirmation({
      messageType: "ConfirmationCard",
      actionId: "a",
      adaptiveCards: [],
    });
    expect(c?.isConsequential).toBe(true);
  });

  it("picks affirmative even when it is listed after the negative", () => {
    const c = parseActionConfirmation(triggerMsg);
    assert(c !== null, "Expected a confirmation trigger");
    expect(c.confirmationOption).toBe("confirm");
  });
});

describe("buildResumeInvokeAction", () => {
  it("builds a ResumeInvokeAction message echoing the trigger (decompile-exact)", () => {
    const c = parseActionConfirmation(triggerMsg);
    assert(c !== null, "Expected a confirmation trigger");
    const msg = buildResumeInvokeAction(c);
    expect(msg.messageType).toBe("ResumeInvokeAction");
    expect(msg.actionId).toBe("act_123");
    expect(msg.sourceRequestId).toBe("req_abc");
    expect(msg.author).toBe("user");
    // text = the affirmative button's TITLE ("Allow"), per the real client's y()/v().
    expect(msg.text).toBe("Allow");
    // confirmationOption is NOT a top-level field of the resume message.
    expect("confirmationOption" in msg).toBe(false);
    expect(Array.isArray(msg.invokeActionMessages)).toBe(true);
    expect((msg.invokeActionMessages as unknown[])[0]).toBe(triggerMsg);
  });

  it("falls back to 'confirmation response' when no title/option is present", () => {
    const c = parseActionConfirmation({
      messageType: "ConfirmationCard",
      actionId: "a",
      adaptiveCards: [],
    });
    assert(c !== null, "Expected a confirmation");
    const msg = buildResumeInvokeAction(c);
    expect(msg.text).toBe("confirmation response");
    expect("confirmationOption" in msg).toBe(false);
  });
});

describe("shouldAutoConfirm", () => {
  it("auto-confirms non-consequential (read-only) actions", () => {
    const c = parseActionConfirmation(triggerMsg); // isConsequential: false
    assert(c !== null, "Expected a confirmation trigger");
    expect(shouldAutoConfirm(c)).toBe(true);
  });

  it("does NOT auto-confirm consequential actions unless opted in", () => {
    const c = parseActionConfirmation({
      messageType: "ConfirmationCard",
      actionId: "a",
      isConsequential: true,
      adaptiveCards: [],
    });
    assert(c !== null, "Expected a confirmation");
    expect(shouldAutoConfirm(c)).toBe(false);
    expect(shouldAutoConfirm(c, { autoConfirmAll: true })).toBe(true);
  });
});

describe("ACTION_ALLOWED_MESSAGE_TYPES", () => {
  it("includes the trigger vocabulary the server must be allowed to send", () => {
    expect(ACTION_ALLOWED_MESSAGE_TYPES).toContain("TriggerConfirmation");
    expect(ACTION_ALLOWED_MESSAGE_TYPES).toContain("TriggerPlugin");
  });
});
