import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ClaudeStreamSession } from "../session.js";

/**
 * Drives the real `claude`. Off by default — needs the binary, a login, and two model round
 * trips — and kept for the reason the other live tests are: the fixture is one capture, and
 * a protocol only drifts in the parts nobody captured.
 *
 * Run: `LOTUS_LIVE_CLAUDE=1 bunx vitest run src/adapters/mobile/structured/bridges/claude/__tests__/session.live.test.ts`
 *
 * Note `CLAUDE_CONFIG_DIR`: auth is per profile in the keychain, so a run under a different
 * profile than the one that logged in reads as an expired session rather than a bug here.
 */
describe.skipIf(process.env["LOTUS_LIVE_CLAUDE"] !== "1")("ClaudeStreamSession (live)", () => {
  it("runs two turns on one process, and reports what it used", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lotus-claude-live-"));
    writeFileSync(join(cwd, "notes.txt"), "alpha\nbeta\n");
    const session = new ClaudeStreamSession({
      paneId: "ss-live-claude",
      cwd,
      permissionMode: "bypassPermissions",
    });
    try {
      await session.start();
      await session.prompt("Read notes.txt and reply with its last line and nothing else.");
      const [first] = session.conversation.page().turns;
      expect(first?.stopReason).toBe("end_turn");
      expect(session.thread).toMatch(/^[0-9a-f-]{36}$/);
      const said = first?.parts.filter((p) => p.type === "assistant_text").at(-1);
      expect((said as { text: string }).text.toLowerCase()).toContain("beta");
      const call = first?.parts.find((p) => p.type === "tool_call");
      expect(call).toMatchObject({ status: "completed" });
      // The signal Cursor does not give: a quota wall here is a fact, not a sentence.
      expect(session.conversation.rateLimit?.window).toBeTruthy();

      // The finding this bridge rests on: one process, and the same conversation.
      const threadAfterFirst = session.thread;
      await session.prompt("Reply with exactly: pong");
      expect(session.conversation.page().turns).toHaveLength(2);
      expect(session.thread).toBe(threadAfterFirst);
    } finally {
      session.close();
    }
  }, 240_000);

  it("stops and asks before a gated tool, and runs it once the answer comes", async () => {
    // Fase 3b end to end: the runner calls the MCP tool this session starts, waits, and the
    // operator's digit releases it. `rm` is the command the probe showed does prompt —
    // `echo` does not, which is why a harmless one proves nothing here.
    const cwd = mkdtempSync(join(tmpdir(), "lotus-claude-approve-"));
    writeFileSync(join(cwd, "doomed.txt"), "scratch\n");
    const session = new ClaudeStreamSession({ paneId: "ss-live-approve", cwd, permissionMode: "manual" });
    try {
      await session.start();
      const turn = session.prompt("Run this shell command exactly: rm -f doomed.txt");

      const deadline = Date.now() + 90_000;
      while (session.conversation.pendingPermission() === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const asked = session.conversation.pendingPermission();
      expect(asked?.title).toContain("rm -f doomed.txt");
      // Three since the standing grant landed: once, all-Bash-until-this-cell-closes, deny.
      expect(asked?.options.map((o) => o.kind)).toEqual([
        "allow_once",
        "allow_always",
        "reject_once",
      ]);

      // Once, deliberately: this test is about the gate opening for one call, and answering it
      // with the standing grant would stop proving that.
      expect(session.decide("1")).toBe(true);
      await turn;

      expect(session.conversation.pendingPermission()).toBeUndefined();
      expect(existsSync(join(cwd, "doomed.txt"))).toBe(false);
    } finally {
      session.close();
    }
  }, 240_000);

  /**
   * A question is not a permission, and until 2026-09-08 this channel could not tell them
   * apart: `AskUserQuestion` arrived as a card reading its own tool name above **Allow once**
   * and **Deny**, and allowing it made the tool run and report *"No answer received"*. So the
   * operator tapped an option and the agent was told nobody replied.
   *
   * The proof this test exists for is the last line: the agent has to *name the option the
   * operator chose*. Anything less passes just as well with the old behaviour.
   */
  it("puts a question to the operator, and carries the answer back to the agent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lotus-claude-ask-"));
    const session = new ClaudeStreamSession({ paneId: "ss-live-ask", cwd, permissionMode: "manual" });
    try {
      await session.start();
      const turn = session.prompt(
        "Use the AskUserQuestion tool to ask me exactly one question: tabs or spaces? " +
          "Offer exactly two options, labelled Spaces and Tabs. " +
          "Then reply with one short sentence naming the answer you received. Do nothing else.",
      );

      const deadline = Date.now() + 90_000;
      while (session.conversation.pendingPermission() === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const asked = session.conversation.pendingPermission();
      // The runner's own words, not the tool's name — and its own options, not allow/deny.
      expect(asked?.title.toLowerCase()).toContain("tab");
      expect(asked?.options.map((o) => o.label)).toEqual(
        expect.arrayContaining(["Spaces", "Tabs"]),
      );

      const tabs = asked?.options.find((o) => o.label === "Tabs");
      expect(tabs).toBeDefined();
      expect(session.decide(tabs?.key ?? "")).toBe(true);
      await turn;

      const said = (session.conversation.page().turns[0]?.parts ?? [])
        .flatMap((p) => (p.type === "assistant_text" ? [p.text] : []))
        .join(" ");
      expect(said).toContain("Tabs");
      expect(said).not.toContain("No answer received");
    } finally {
      session.close();
    }
  }, 240_000);

  /**
   * The standing grant, end to end. The assertion that matters is the **count**: one card for
   * two gated calls. Answering each one separately passes any weaker check just as well, which
   * is how a grant that quietly did nothing would ship.
   */
  it("asks once when the operator grants the tool for the rest of the cell", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lotus-claude-grant-"));
    const session = new ClaudeStreamSession({ paneId: "ss-live-grant", cwd, permissionMode: "manual" });
    try {
      await session.start();
      const turn = session.prompt(
        "Run these two shell commands with the Bash tool, one after the other: " +
          "first `echo one > a.txt`, then `echo two > b.txt`. Then say done.",
      );

      const deadline = Date.now() + 120_000;
      while (session.conversation.pendingPermission() === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const asked = session.conversation.pendingPermission();
      const standing = asked?.options.find((o) => o.kind === "allow_always");
      expect(standing?.label).toContain("Bash");
      expect(session.decide(standing?.key ?? "")).toBe(true);

      await turn;

      const cards = (session.conversation.page().turns[0]?.parts ?? []).filter(
        (p) => p.type === "permission",
      );
      expect(existsSync(join(cwd, "a.txt"))).toBe(true);
      expect(existsSync(join(cwd, "b.txt"))).toBe(true);
      expect(cards).toHaveLength(1);
    } finally {
      session.close();
    }
  }, 240_000);

  /**
   * Postur yang bergerak, terhadap CLI sungguhan. Pasangannya adalah test di atas, yang sudah
   * membuktikan `manual` **memang** menggerbangi `rm -f` — tanpa itu, nol kartu di sini bisa
   * berarti perintahnya kebetulan tak pernah digerbangi.
   */
  it("loosens a running cell without restarting it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lotus-claude-posture-"));
    writeFileSync(join(cwd, "doomed.txt"), "scratch\n");
    const session = new ClaudeStreamSession({ paneId: "ss-live-posture", cwd, permissionMode: "manual" });
    try {
      await session.start();
      await session.prompt("Reply with the single word ready and use no tools.");
      const before = session.thread;

      await session.setPermissionMode("acceptEdits");
      expect(session.permissionMode).toBe("acceptEdits");

      await session.prompt("Run this shell command exactly: rm -f doomed.txt");

      const cards = session.conversation
        .page()
        .turns.flatMap((t) => t.parts)
        .filter((p) => p.type === "permission");
      expect(existsSync(join(cwd, "doomed.txt"))).toBe(false);
      expect(cards).toHaveLength(0);
      // Same process, same thread: the conversation survived the change.
      expect(session.thread).toBe(before);
      expect(session.conversation.page().turns).toHaveLength(2);
    } finally {
      session.close();
    }
  }, 240_000);
});
