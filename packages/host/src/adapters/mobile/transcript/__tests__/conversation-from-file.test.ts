import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { conversationPage } from "../../conversation-routes.js";
import type { FleetMember } from "../../../../types/fleet.js";
import { readTuiTranscript } from "../tui-source.js";

const SESSION = readFileSync(join(__dirname, "fixtures", "claude-session.jsonl"), "utf8");

/**
 * Slice 3.4. `/conversation` needed no new route — it is built on the same read as
 * `/transcript`, and slice 3.3 gave that read a local source. So what is actually unproven is
 * narrower and more interesting: do the entries **this host produces from a runner's file** turn
 * into sensible turns?
 *
 * The two halves were written years apart in different places. `turnsFromEntries` learned its
 * rules from the desktop's hook ring, where a turn opens on `prompt-submit` and a `tool-pre` is
 * completed by the next `tool-post`. `readClaudeTranscript` produces that same vocabulary from a
 * file. Nothing had ever run one into the other.
 */
const page = () =>
  readTuiTranscript("pane-7", {}, {
    sourceOf: () => ({ transcriptPath: "/t/a.jsonl" }),
    providerOf: () => "claude",
    readFile: () => ({ ok: true, text: SESSION }),
  });

const member = (over: Partial<FleetMember> = {}): FleetMember => ({
  paneId: "pane-7",
  agentType: "claude",
  ...over,
} as FleetMember);

describe("a file-read transcript as a conversation", () => {
  it("becomes one turn: the operator's ask, its steps, and the reply", () => {
    const conversation = conversationPage("pane-7", member(), page());

    expect(conversation.turns).toHaveLength(1);
    expect(conversation.turns[0]?.parts.map((p) => p.type)).toEqual([
      "user_message",
      "tool_call",
      "tool_call",
      "assistant_text",
    ]);
  });

  /**
   * The rule that matters most here: a `tool-pre` and the `tool-post` after it are **one** part,
   * not two. Our reader emits them as separate entries, exactly as the ring does.
   */
  it("pairs each call with its result rather than listing four steps", () => {
    const parts = conversationPage("pane-7", member(), page()).turns[0]?.parts ?? [];
    const calls = parts.filter((p) => p.type === "tool_call");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ status: "completed" });
    }
  });

  it("keeps the operator's words and the agent's reply verbatim", () => {
    const parts = conversationPage("pane-7", member(), page()).turns[0]?.parts ?? [];

    expect(parts[0]).toMatchObject({
      type: "user_message",
      text: "Baca berkas catatan.txt lalu jawab satu kalimat pendek apa isinya.",
    });
    expect(parts[parts.length - 1]).toMatchObject({
      type: "assistant_text",
      text: 'Isinya cuma teks "halo".',
    });
  });

  /**
   * `derived`, not `hook`: these parts were reconstructed from a file the CLI wrote, not
   * observed as they happened. A client that renders provenance must not claim otherwise.
   */
  it("marks every part as derived from the file", () => {
    const conversation = conversationPage("pane-7", member(), page());

    expect(conversation.source).toBe("file");
    for (const part of conversation.turns[0]?.parts ?? []) {
      expect(part.provenance).toBe("derived");
    }
  });

  it("carries the paging fields through, so Chat can walk backwards", () => {
    const conversation = conversationPage("pane-7", member(), readTuiTranscript("pane-7", { limit: 2 }, {
      sourceOf: () => ({ transcriptPath: "/t/a.jsonl" }),
      providerOf: () => "claude",
      readFile: () => ({ ok: true, text: SESSION }),
    }));

    expect(conversation).toMatchObject({ hasMore: true, oldestCursor: 4, totalEver: 6 });
  });

  /** The honest empty survives the reshaping: nothing yet is not a fault. */
  it("does not invent a fault for a pane with nothing yet", () => {
    const conversation = conversationPage("pane-7", member(), {
      paneId: "pane-7", total: 0, entries: [],
    });

    expect(conversation.turns).toEqual([]);
    expect(conversation).not.toHaveProperty("hostSupports");
  });
});
