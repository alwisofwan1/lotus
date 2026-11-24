import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ConversationUpdate } from "../../../../types/conversation.js";
import type { TranscriptEntry } from "../../../../types/transcript.js";
import { NativeConversation } from "../../codex-app-server/native-conversation.js";
import { AcpConversation } from "../../structured/bridges/acp/conversation.js";
import type { AcpUpdate } from "../../structured/bridges/acp/parts.js";
import { ClaudeConversation } from "../../structured/bridges/claude/conversation.js";
import type { ClaudeMessage } from "../../structured/bridges/claude/messages.js";
import { readClaudeTranscript } from "../../transcript/claude-transcript.js";
import { ConversationStream } from "../conversation-stream.js";
import { ConversationGrammar, type GrammarViolation } from "../grammar.js";

/**
 * Every producer of conversation deltas, replayed against a **real recording** of the CLI it
 * speaks for, checked against one grammar.
 *
 * This is `bb`'s discipline, which it applies as `bridge.conformance.test.ts` beside each
 * provider plugin plus a recorded twin: a bridge is not "done" because its own unit tests pass,
 * it is done when its output is legal. Lotus had four producers and four sets of assumptions,
 * and the gap between them reached a phone on 2026-09-08 as one exchange drawn twice.
 *
 * The recordings are the ones the individual bridge tests already replay, so a capture that is
 * refreshed for one test is refreshed for this one — there is no second set of fixtures to keep
 * honest.
 */
const HERE = __dirname;
const CLAUDE_FIXTURE = join(HERE, "../../structured/bridges/claude/__tests__/fixtures/claude-stream-turn.jsonl");
const ACP_FIXTURE = join(HERE, "../../structured/bridges/acp/__tests__/fixtures/cursor-acp-turn.jsonl");
const CODEX_FIXTURE = join(HERE, "../../codex-app-server/__tests__/fixtures/app-server-turn.jsonl");
const HOOK_FIXTURE = join(HERE, "../../transcript/__tests__/fixtures/claude-session.jsonl");

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
}

/** Runs one producer and reports every rule it broke, in order. */
function violationsOf(paneId: string, run: (emit: (u: ConversationUpdate) => void) => void): GrammarViolation[] {
  const grammar = new ConversationGrammar();
  const broken: GrammarViolation[] = [];
  run((update) => {
    const bad = grammar.observe(paneId, update);
    if (bad !== undefined) broken.push(bad);
  });
  return broken;
}

/** What each producer emitted, so a conformance run that finds nothing still proves it ran. */
function countOf(run: (emit: (u: ConversationUpdate) => void) => void): { turns: number; parts: number } {
  let turns = 0;
  let parts = 0;
  run((u) => { if (u.kind === "turn") turns += 1; else parts += 1; });
  return { turns, parts };
}

const producers: Array<{
  name: string;
  paneId: string;
  run: (emit: (u: ConversationUpdate) => void) => void;
}> = [
  {
    name: "the Claude bridge, over `claude --output-format stream-json`",
    paneId: "ss-claude",
    run: (emit) => {
      const c = new ClaudeConversation("ss-claude");
      c.onUpdate(emit);
      c.openTurn("Read notes.txt and then append a line 'gamma' to it.");
      for (const line of lines(CLAUDE_FIXTURE)) c.apply(JSON.parse(line) as ClaudeMessage);
    },
  },
  {
    name: "the ACP bridge, over a real cursor-agent session",
    paneId: "ss-acp",
    run: (emit) => {
      const c = new AcpConversation("ss-acp", "cursor");
      c.onUpdate(emit);
      c.openTurn("Read notes.txt, then add a line 'delta' to the end of it. Then run: echo done");
      for (const line of lines(ACP_FIXTURE)) {
        c.apply((JSON.parse(line) as { update: AcpUpdate }).update);
      }
      c.closeTurn("end_turn");
    },
  },
  {
    name: "the codex app-server bridge",
    paneId: "ss-codex",
    run: (emit) => {
      const c = new NativeConversation("ss-codex");
      c.onUpdate(emit);
      for (const line of lines(CODEX_FIXTURE)) {
        const msg = JSON.parse(line) as { method?: string; params?: unknown };
        if (msg.method !== undefined) c.apply(msg.method, msg.params);
      }
    },
  },
  {
    name: "the hook lane, converting a TUI cell's own transcript",
    paneId: "pane-hook",
    run: (emit) => {
      const stream = new ConversationStream();
      const entries: TranscriptEntry[] = readClaudeTranscript(readFileSync(HOOK_FIXTURE, "utf8"));
      // One entry at a time, which is how it runs: each arrival re-converts and diffs.
      for (let i = 1; i <= entries.length; i++) {
        for (const update of stream.replace("pane-hook", entries.slice(0, i))) emit(update);
      }
    },
  },
];

describe("conversation grammar conformance", () => {
  for (const producer of producers) {
    describe(producer.name, () => {
      it("emits something at all, so a clean run is not an empty one", () => {
        const { turns, parts } = countOf(producer.run);
        expect(turns).toBeGreaterThan(0);
        expect(parts).toBeGreaterThan(0);
      });

      it("breaks no rule", () => {
        const broken = violationsOf(producer.paneId, producer.run);
        expect(broken, broken.map((b) => `${b.rule}: ${b.reason}`).join("\n")).toEqual([]);
      });
    });
  }

  /**
   * The checker has to be able to fail, or a suite of green ticks proves nothing. This is the
   * 2026-09-08 bug replayed deliberately: the same part, filed under a second turn.
   */
  it("fails a producer that files one part under two turns", () => {
    const broken = violationsOf("pane-bad", (emit) => {
      emit({ kind: "turn", turn: { turnId: "t-1", startedAt: 1 } });
      emit({ kind: "part", turnId: "t-1", part: { id: "a", ts: 1, seq: 0, provenance: "hook", type: "user_message", text: "Halo" } });
      emit({ kind: "turn", turn: { turnId: "t-2", startedAt: 2 } });
      emit({ kind: "part", turnId: "t-2", part: { id: "a", ts: 1, seq: 0, provenance: "hook", type: "user_message", text: "Halo" } });
    });
    expect(broken.map((b) => b.rule)).toEqual(["part/one-turn"]);
  });
});
