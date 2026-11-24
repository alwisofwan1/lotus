import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StructuredSessions } from "../../../structured-sessions.js";
import { acpAgent } from "../known-agents.js";
import { AcpSession } from "../session.js";

/**
 * Drives the real `cursor-agent acp`. Off by default — needs the binary, a Cursor login, and
 * a model round trip — and kept for the reason the Codex live test is: the fixture is one
 * capture, and a protocol only drifts in the parts nobody captured.
 *
 * Run: `LOTUS_LIVE_CURSOR=1 bunx vitest run src/adapters/mobile/structured/bridges/acp/__tests__/session.live.test.ts`
 *
 * **A failure here is not automatically a bridge failure.** Run against an exhausted Cursor
 * plan on 2026-09-07, the whole path worked and the agent's answer was the prose
 * "upgrade your plan to continue", with `stopReason: end_turn`, no error, and no usage
 * signal — a quota wall is indistinguishable from an answer on this wire. Check the text
 * before suspecting the transport.
 */
const live = process.env["LOTUS_LIVE_CURSOR"] === "1";
const cursor = acpAgent("cursor");

describe.skipIf(!live || cursor === undefined)("AcpSession against cursor-agent (live)", () => {
  it("runs one turn with no terminal, and reports the tool it used", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lotus-acp-live-"));
    writeFileSync(join(cwd, "notes.txt"), "alpha\nbeta\n");
    if (cursor === undefined) throw new Error("unreachable");
    const session = new AcpSession({ paneId: "ss-live-acp", cwd, agent: cursor });
    try {
      await session.start();
      expect(session.thread).toMatch(/^[0-9a-f-]{36}$/);
      await session.prompt("Read notes.txt and reply with its last line and nothing else.");
      const [turn] = session.conversation.page().turns;
      expect(turn?.stopReason).toBe("end_turn");
      const said = turn?.parts.filter((p) => p.type === "assistant_text").at(-1);
      expect(said).toMatchObject({ type: "assistant_text", state: "done" });
      expect((said as { text: string }).text.toLowerCase()).toContain("beta");
      const call = turn?.parts.find((p) => p.type === "tool_call");
      expect(call).toMatchObject({ kind: "read", status: "completed" });
      // The quirk this whole normalizer exists for.
      expect((call as { toolCallId: string }).toolCallId).not.toContain("\n");
    } finally {
      session.close();
    }
  }, 180_000);

  it("appears in the fleet as an ordinary cell, spawned through the store", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lotus-acp-fleet-"));
    const store = new StructuredSessions({ publishNotification: () => {}, fleetChanged: () => {} });
    const member = await store.spawn({ workspaceId: "ws-live", cwd, agentType: "cursor" });
    try {
      expect(member).toMatchObject({ agentType: "cursor", runnerLabel: "Cursor", gating: "skipped" });
      expect(member.paneId).toMatch(/^ss-[0-9a-f]{8}$/);
      expect(store.list("ws-live")).toHaveLength(1);
      expect(await store.dispatch(member.paneId, "Reply with exactly: pong")).toBe("sent");
      const page = store.page(member.paneId);
      expect(page?.runner).toBe("cursor");
      expect(page?.capabilities.streaming).toBe("expected");
    } finally {
      store.closeAll();
    }
  }, 180_000);
});
