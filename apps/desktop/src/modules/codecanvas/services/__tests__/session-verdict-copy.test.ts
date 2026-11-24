import { describe, expect, it } from "vitest";
import { needsYouConfirmText, verdictNotice } from "../session-verdict-copy";
import type { CanvasSessionRecord } from "../session-record";

const session = {
  id: "sess-1",
  projectId: "cp_1",
  nodeId: "agent-1",
  runner: "claude",
  status: "resumable",
  createdAt: 0,
  lastActivityAt: 0,
} as CanvasSessionRecord;

describe("verdictNotice", () => {
  // The reported symptom was a button that did nothing. A refusal must become a sentence, so every
  // blocked verdict has to produce one.
  it("gives a refused relaunch something to say", () => {
    expect(verdictNotice({ allowed: false, reason: "already-active" })).toEqual({
      kind: "info",
      text: "This node is already in that conversation.",
    });
  });

  // "Tidak ada jalur klik yang berakhir tanpa efek dan tanpa pesan" is the whole acceptance
  // criterion, so the exhaustive case is the test: every reason the judge can return must speak.
  it("leaves no refusal without a sentence", () => {
    const reasons = ["already-active", "dead-session", "no-project", "no-runner-command"] as const;
    for (const reason of reasons) {
      const notice = verdictNotice({ allowed: false, reason });
      expect(notice, reason).not.toBeNull();
      expect(notice!.text.length, reason).toBeGreaterThan(0);
    }
  });

  // Found live: the row remembers `custom` but not the command behind it, so there is nothing to
  // rebuild the node with. The user can still fix it — by opening the runner and starting there —
  // so the sentence has to say what is missing, not just "tidak bisa".
  it("names what is missing when a custom runner's command was never recorded", () => {
    const notice = verdictNotice({ allowed: false, reason: "no-runner-command" });
    expect(notice?.kind).toBe("error");
    expect(notice?.text).toContain("command was not saved");
  });

  // A conversation the CLI no longer knows is a dead end, not a hint — it gets the louder channel.
  it("treats a dead conversation as an error, not a note", () => {
    expect(verdictNotice({ allowed: false, reason: "dead-session" })?.kind).toBe("error");
  });

  // An allowed relaunch is its own feedback: the pane restarts in front of you.
  it("stays quiet when the relaunch is going ahead", () => {
    expect(verdictNotice({ allowed: true, intent: { kind: "new" } })).toBeNull();
  });

  // `needs-you` is a question, asked inline by the list that was pressed — not a strip notice.
  it("leaves a needs-you question to the inline confirm", () => {
    expect(
      verdictNotice({ allowed: true, intent: { kind: "resume", session }, confirm: "needs-you" }),
    ).toBeNull();
  });
});

describe("needsYouConfirmText", () => {
  it("names the agent and what it is waiting on", () => {
    expect(needsYouConfirmText("Rei", "Apply edit to redirect.ts?")).toBe(
      "Rei is waiting for your answer to “Apply edit to redirect.ts?”. Opening this ends that turn.",
    );
  });

  it("still reads without a name or a headline", () => {
    expect(needsYouConfirmText()).toBe("This agent is waiting for your answer. Opening this ends that turn.");
  });
});
