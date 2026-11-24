import { describe, expect, it } from "vitest";

import { describeVoiceAdapterContract } from "@/modules/voice-core/testing/voice-adapter-contract";

import { CHAT_VOICE_NOT_SENT_REASON, CHAT_VOICE_REVIEW_REASON, createChatVoiceAdapter, joinDictation, type ChatVoiceDeps } from "../voice";

function harness(overrides: Partial<ChatVoiceDeps> = {}) {
  const inserted: string[] = [];
  let sent = 0;
  const adapter = createChatVoiceAdapter({
    thread: { id: "t1", name: "Auth fix" },
    insert: (text) => inserted.push(text),
    send: () => {
      sent += 1;
      return true;
    },
    sendRightAway: () => false,
    ...overrides,
  });
  return { adapter, inserted, sent: () => sent };
}

describeVoiceAdapterContract("Chat", () => {
  const h = harness();
  return {
    adapter: h.adapter,
    targetNames: ["Auth fix"],
    sendable: { text: "fix the test", intent: { source: "voice", sendNow: true } },
    holdable: { text: "fix the test", intent: { source: "voice" } },
    effects: () => h.inserted.length + h.sent(),
  };
});

describe("Chat Voice Adapter", () => {
  it("puts a spoken turn in the composer, unsent, by default", async () => {
    const h = harness();
    const result = await h.adapter.deliver("  rename the cookie  ", { source: "voice" });
    expect(result).toEqual({ status: "held", route: "composer", text: "rename the cookie", reason: CHAT_VOICE_REVIEW_REASON });
    expect(h.inserted).toEqual(["rename the cookie"]);
    expect(h.sent()).toBe(0);
  });

  it("sends when Send Right Away is on", async () => {
    const h = harness({ sendRightAway: () => true });
    expect((await h.adapter.deliver("go", { source: "voice" })).status).toBe("sent");
    expect(h.sent()).toBe(1);
  });

  it("keeps the text, saying why, when the composer cannot send now", async () => {
    const h = harness({ send: () => false });
    const result = await h.adapter.deliver("go", { source: "voice", sendNow: true });
    expect(result).toMatchObject({ status: "held", reason: CHAT_VOICE_NOT_SENT_REASON });
    expect(h.inserted).toEqual(["go"]);
  });
});

describe("joinDictation", () => {
  it.each([
    ["", "rename it", "Rename it"],
    ["Yes please,", "rename it", " rename it"],
    ["Yes please, ", "rename it", "rename it"],
    ["Done.", "now the docs", " Now the docs"],
    ["Done. ", "now the docs", "Now the docs"],
    ["Fix ", "React hooks", "React hooks"],
    ["anything", "   ", ""],
    ["天気ですね。", "ありがとうございます", "ありがとうございます"],
    ["Cek file ini,", "そしてテストを", " そしてテストを"],
    ["ログインの", "auth.ts", "auth.ts"],
    ["안녕하세요.", "감사합니다", " 감사합니다"],
  ])("after %j, %j reads %j", (before, spoken, expected) => {
    expect(joinDictation(before, spoken)).toBe(expected);
  });
});
