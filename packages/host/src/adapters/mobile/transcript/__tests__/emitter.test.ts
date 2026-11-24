import { describe, expect, it } from "vitest";

import { TranscriptEmitter } from "../emitter.js";

/**
 * Slice 3.6, and it exists because of what the operator saw on a real phone: Chat read the
 * conversation correctly and never moved until they pulled to refresh.
 *
 * The cause was not the reading. `LiveTranscript` on the phone appends from `notification`
 * frames carrying a hook payload (`live_transcript.dart` — `event.hook.toTranscriptEntry()`),
 * and a standalone host published none. It recorded every turn and then said nothing.
 *
 * So this turns "a hook fired" into "here is what is new in the file", which is the same source
 * `/transcript` serves. Nothing is invented for the wire: an entry the phone appends live and the
 * same entry fetched later are the same entry, from the same file.
 */
const ENTRY = (event: string, at: number) => ({
  event, status: "running", title: "Bash", body: "", userPrompt: "", toolTarget: "ls", timestamp: at,
});

describe("TranscriptEmitter", () => {
  it("publishes the entries a pane has gained since last time", () => {
    const published: any[] = [];
    let entries = [ENTRY("prompt-submit", 1), ENTRY("tool-pre", 2)];
    const emitter = new TranscriptEmitter({
      entriesOf: () => entries,
      publish: (e) => published.push(e),
    });

    emitter.onTurn("pane-7", "claude");
    expect(published.map((e) => e.event)).toEqual(["prompt-submit", "tool-pre"]);

    entries = [...entries, ENTRY("tool-post", 3)];
    emitter.onTurn("pane-7", "claude");
    expect(published.map((e) => e.event)).toEqual(["prompt-submit", "tool-pre", "tool-post"]);
  });

  it("says nothing when nothing was added", () => {
    const published: any[] = [];
    const emitter = new TranscriptEmitter({
      entriesOf: () => [ENTRY("prompt-submit", 1)],
      publish: (e) => published.push(e),
    });

    emitter.onTurn("pane-7", "claude");
    emitter.onTurn("pane-7", "claude");

    expect(published).toHaveLength(1);
  });

  /** The wire shape the phone already parses — snake_case, and the pane it belongs to. */
  it("publishes the shape a phone appends without a new parser", () => {
    const published: any[] = [];
    new TranscriptEmitter({
      entriesOf: () => [{
        event: "tool-pre", status: "running", title: "Bash", body: "",
        userPrompt: "clean up", toolTarget: "rm shim.ts", timestamp: 1785664800000,
        linesAdded: 2, linesRemoved: 34,
      }],
      publish: (e) => published.push(e),
    }).onTurn("pane-7", "claude");

    expect(published[0]).toEqual({
      kind: "agent_stop",
      pane_id: "pane-7",
      agent_type: "claude",
      cwd: "",
      event: "tool-pre",
      status: "running",
      title: "Bash",
      body: "",
      user_prompt: "clean up",
      tool_target: "rm shim.ts",
      lines_added: 2,
      lines_removed: 34,
      timestamp: 1785664800000,
    });
  });

  /** Absent, not zero — a `Read` step must not render "+0 -0". */
  it("leaves a diffstat out when the step changed no lines", () => {
    const published: any[] = [];
    new TranscriptEmitter({
      entriesOf: () => [ENTRY("tool-pre", 1)],
      publish: (e) => published.push(e),
    }).onTurn("pane-7", "claude");

    expect(published[0]).not.toHaveProperty("lines_added");
    expect(published[0]).not.toHaveProperty("lines_removed");
  });

  it("keeps panes apart", () => {
    const published: any[] = [];
    const emitter = new TranscriptEmitter({
      entriesOf: (paneId) => (paneId === "a" ? [ENTRY("prompt-submit", 1)] : []),
      publish: (e) => published.push(e),
    });

    emitter.onTurn("a", "claude");
    emitter.onTurn("b", "claude");

    expect(published.map((e) => e.pane_id)).toEqual(["a"]);
  });

  /**
   * A file that shrank — a resumed session writing a new one — must not replay silence. The
   * cursor drops back rather than holding a count the file can no longer reach.
   */
  it("recovers when the file it was following is replaced by a shorter one", () => {
    const published: any[] = [];
    let entries = [ENTRY("a", 1), ENTRY("b", 2), ENTRY("c", 3)];
    const emitter = new TranscriptEmitter({
      entriesOf: () => entries,
      publish: (e) => published.push(e),
    });
    emitter.onTurn("pane-7", "claude");

    entries = [ENTRY("x", 4)];
    emitter.onTurn("pane-7", "claude");

    expect(published.map((e) => e.event)).toEqual(["a", "b", "c", "x"]);
  });

  it("forgets a pane whose cell has gone", () => {
    const published: any[] = [];
    const emitter = new TranscriptEmitter({
      entriesOf: () => [ENTRY("a", 1)],
      publish: (e) => published.push(e),
    });

    emitter.onTurn("pane-7", "claude");
    emitter.forget("pane-7");
    emitter.onTurn("pane-7", "claude");

    expect(published).toHaveLength(2);
  });
});
