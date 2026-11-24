import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerSession } from "../session.js";

/**
 * Drives the real `codex app-server`. Off by default — needs the binary, a login, and a
 * model round trip — and kept in the tree for the reason the Rust live reader test is:
 * the fixture is one capture, and the protocol only drifts in the parts nobody captured.
 *
 * Run: `LOTUS_LIVE_CODEX=1 bunx vitest run src/adapters/mobile/codex-app-server/__tests__/session.live.test.ts`
 */
describe.skipIf(process.env["LOTUS_LIVE_CODEX"] !== "1")("CodexAppServerSession (live)", () => {
  it("starts a thread, runs one turn without a terminal, and closes it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lotus-codex-live-"));
    const session = new CodexAppServerSession({ paneId: "ss-live", cwd, approvalPolicy: "never", sandbox: "workspace-write" });
    try {
      await session.start();
      expect(session.thread).toMatch(/^[0-9a-f-]{36}$/);
      await session.prompt("Reply with exactly one word: pong");
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && session.conversation.page().turns[0]?.endedAt === undefined) {
        await new Promise((r) => setTimeout(r, 500));
      }
      const [turn] = session.conversation.page().turns;
      expect(turn?.stopReason).toBe("end_turn");
      const said = turn?.parts.filter((p) => p.type === "assistant_text").at(-1);
      expect(said).toMatchObject({ type: "assistant_text", state: "done" });
      expect((said as { text: string }).text.toLowerCase()).toContain("pong");
    } finally {
      session.close();
    }
  }, 120_000);
});
