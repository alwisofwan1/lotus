import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readTuiTranscript, type TuiTranscriptDeps } from "../tui-source.js";

const SESSION = readFileSync(join(__dirname, "fixtures", "claude-session.jsonl"), "utf8");

const deps = (over: Partial<TuiTranscriptDeps> = {}): TuiTranscriptDeps => ({
  sourceOf: () => ({ transcriptPath: "/t/a.jsonl" }),
  providerOf: () => "claude",
  readFile: () => ({ ok: true, text: SESSION }) as const,
  ...over,
});

/**
 * Slice 3.3. The entries are the easy half. What this suite is really about is the three
 * silences `contract/README.md` separates, because a client's next move differs for each:
 *
 * - `hostSupports: false` — this host cannot know. Open the terminal.
 * - `transcriptOutlook: "never"` — this runner has nothing to report with. Stop waiting.
 * - both absent, `entries: []` — the pane has nothing **yet**. Wait, or pull to refresh.
 *
 * Collapsing any two of those throws away the only thing that tells an operator whether to
 * wait, to go and fix something, or to stop expecting anything at all.
 */
describe("readTuiTranscript", () => {
  it("serves the runner's own file, oldest first", () => {
    const page = readTuiTranscript("pane-7", {}, deps());

    expect(page?.paneId).toBe("pane-7");
    expect(page?.entries.map((e) => e.event)).toEqual([
      "prompt-submit", "tool-pre", "tool-post", "tool-pre", "tool-post", "stop",
    ]);
    expect(page?.total).toBe(6);
  });

  /** `file`, not `ring`: durable and pageable, which is the point of Fase 3. */
  it("says where the entries came from, and which file", () => {
    const page = readTuiTranscript("pane-7", {}, deps());

    expect(page?.source).toBe("file");
    expect(page?.transcriptPath).toBe("/t/a.jsonl");
  });

  describe("paging, ending at the newest", () => {
    it("returns the newest page and a cursor into the past", () => {
      const page = readTuiTranscript("pane-7", { limit: 2 }, deps());

      expect(page?.entries.map((e) => e.event)).toEqual(["tool-post", "stop"]);
      expect(page?.oldestCursor).toBe(4);
      expect(page?.hasMore).toBe(true);
      // Beside `total`, never replacing it: `total` has always meant "in this response".
      expect(page?.total).toBe(2);
      expect(page?.totalEver).toBe(6);
    });

    it("walks further back from the cursor it gave", () => {
      const page = readTuiTranscript("pane-7", { before: 4, limit: 2 }, deps());

      expect(page?.entries.map((e) => e.event)).toEqual(["tool-post", "tool-pre"]);
      expect(page?.oldestCursor).toBe(2);
      expect(page?.hasMore).toBe(true);
    });

    it("says nothing older exists once it reaches the start", () => {
      const page = readTuiTranscript("pane-7", { before: 2, limit: 10 }, deps());

      expect(page?.entries.map((e) => e.event)).toEqual(["prompt-submit", "tool-pre"]);
      expect(page?.hasMore).toBe(false);
      expect(page?.oldestCursor).toBe(0);
    });
  });

  describe("the three silences", () => {
    /**
     * The healthy empty. The hook pipeline works, the runner reports, and this pane simply has
     * not said anything yet — which a client renders as "nothing yet", not as a fault.
     */
    it("stays silent about faults when a pane just has nothing yet", () => {
      const page = readTuiTranscript("pane-7", {}, deps({ sourceOf: () => undefined }));

      expect(page).toMatchObject({ total: 0, entries: [] });
      expect(page).not.toHaveProperty("hostSupports");
      expect(page).not.toHaveProperty("transcriptOutlook");
      expect(page).not.toHaveProperty("runnerReports");
    });

    /**
     * A runner whose format this host has no reader for answers `"never"` — the same thing
     * the **desktop** says about the same cell, which is the point.
     *
     * It was `hostSupports: false` until 2026-09-08, on the reasoning that codex does write a
     * transcript and only this host cannot read it. True, and it made the phone print *"this
     * machine is not recording what its agents do — check Lotus on that desktop"* over a
     * codex cell sitting beside a claude cell whose Chat was working, on a standalone host
     * with no desktop to check. Both answers are approximations; this is the one whose advice
     * — the raw terminal — is the advice that works, and the one that stops two hosts
     * disagreeing about the same cell.
     */
    it("says the outlook is never for a runner it has no reader for", () => {
      const page = readTuiTranscript("pane-7", {}, deps({ providerOf: () => "codex" }));

      expect(page).toMatchObject({ transcriptOutlook: "never", total: 0, entries: [] });
      // Not a claim about the host: the very next pane may be a claude cell it reads fine.
      expect(page).not.toHaveProperty("hostSupports");
    });

    /** Reported, and unreadable. Knowing where a file should be is not reading it. */
    it("says it cannot know when the file it was told about cannot be read", () => {
      const page = readTuiTranscript("pane-7", {}, deps({
        readFile: () => ({ ok: false, missing: false }),
      }));

      expect(page).toMatchObject({ hostSupports: false, total: 0, entries: [] });
      // The path comes along, because it is what tells an operator where to look.
      expect(page?.transcriptPath).toBe("/t/a.jsonl");
    });

    /**
     * Reported, and not written **yet**. Claude sends `transcript_path` from its first hook, on
     * `SessionStart`, and creates the file only when it has something to put in it — so on
     * devbox-vps every cell spent its first seconds looking like a faulty host.
     */
    it("calls a file that does not exist yet nothing-yet, not a fault", () => {
      const page = readTuiTranscript("pane-7", {}, deps({
        readFile: () => ({ ok: false, missing: true }),
      }));

      expect(page).toMatchObject({ total: 0, entries: [], transcriptPath: "/t/a.jsonl" });
      expect(page).not.toHaveProperty("hostSupports");
    });

    /**
     * A pane this host does not run at all. `undefined` rather than any answer: the caller
     * has a desktop to ask, and answering here would put a local opinion in front of it.
     */
    it("declines a pane it does not run, so the caller can ask elsewhere", () => {
      expect(readTuiTranscript("pane-7", {}, deps({ providerOf: () => undefined })))
        .toBeUndefined();
    });
  });

  /** A file that parses to nothing is still a working pipeline, not a fault. */
  it("reports an empty file as nothing yet, with the path it read", () => {
    const page = readTuiTranscript("pane-7", {}, deps({ readFile: () => ({ ok: true, text: "" }) }));

    expect(page).toMatchObject({ total: 0, entries: [], source: "file" });
    expect(page).not.toHaveProperty("hostSupports");
  });
});
