import { describe, expect, it } from "vitest";
import { applyPaneInput, ASK_BUFFER_MAX, createPaneAskBuffer } from "../pane-ask-buffer";
import {
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "@/modules/codespace/services/terminal-keybindings";

// Spelled by code point rather than as literals: these bytes are invisible in a diff, and a stray
// one pasted into a test would be impossible to spot when it later failed.
const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);
const CTRL_C = String.fromCharCode(3);
const CTRL_U = String.fromCharCode(21);
const PASTE_ON = `${ESC}[200~`;
const PASTE_OFF = `${ESC}[201~`;
const ARROW_UP = `${ESC}[A`;
const ARROW_LEFT = `${ESC}[D`;

/** Type a whole string one keystroke at a time, the way xterm actually delivers it. */
function type(text: string, start = ""): { buffer: string; submitted: string[] } {
  const submitted: string[] = [];
  let buffer = start;
  for (const char of text) {
    const step = applyPaneInput(buffer, char);
    buffer = step.buffer;
    if (step.submitted !== null) submitted.push(step.submitted);
  }
  return { buffer, submitted };
}

describe("applyPaneInput", () => {
  it("accumulates typing", () => {
    expect(type("halo").buffer).toBe("halo");
  });

  it("hands over the line on Enter and starts empty again", () => {
    const { buffer, submitted } = type("perbaiki judul agent\r");

    expect(submitted).toEqual(["perbaiki judul agent"]);
    expect(buffer).toBe("");
  });

  it("submits nothing for a bare Enter", () => {
    // Enter on an empty composer is how an operator scrolls past a prompt or wakes a pane. There is
    // no ask in it, and reporting one would blank a perfectly good headline.
    expect(applyPaneInput("", "\r").submitted).toBeNull();
  });

  it("takes a whole line arriving in one write, as a dispatch does", () => {
    // MCP dispatch and the NL command bar write the command and its Enter in a single chunk. This is
    // the path that gives a headline to an agent nobody typed into by hand.
    const step = applyPaneInput("", "jalankan test\r");

    expect(step.submitted).toBe("jalankan test");
    expect(step.buffer).toBe("");
  });

  it("handles backspace", () => {
    expect(type(`halop${BACKSPACE}`).buffer).toBe("halo");
  });

  it("does not backspace past the start", () => {
    expect(type(`${BACKSPACE}${BACKSPACE}hi`).buffer).toBe("hi");
  });

  it("forgets the line on Ctrl+C", () => {
    expect(type(`setengah jadi${CTRL_C}`).buffer).toBe("");
  });

  it("forgets the line on Ctrl+U, which is how a TUI clears it", () => {
    expect(type(`setengah jadi${CTRL_U}`).buffer).toBe("");
  });

  it("ignores arrow keys instead of writing escape junk into the ask", () => {
    const buffer = type("halo").buffer;

    expect(applyPaneInput(buffer, ARROW_UP).buffer).toBe("halo");
    expect(applyPaneInput(buffer, ARROW_LEFT).buffer).toBe("halo");
  });

  describe("Shift+Enter is composing, not submitting", () => {
    // Both encodings, because the runner families differ and META_ENTER_SEQUENCE is ESC + CR —
    // indistinguishable from a submit unless it is recognised first. The same trap that made
    // `inputOpensTurn` misread it, found and fixed the same day.

    it("keeps the line open on a claude-family pane", () => {
      const step = applyPaneInput("baris satu", KITTY_SHIFT_ENTER_SEQUENCE);

      expect(step.submitted).toBeNull();
      expect(step.buffer).toBe("baris satu\n");
    });

    it("keeps the line open on a codex/cursor/custom pane", () => {
      const step = applyPaneInput("baris satu", META_ENTER_SEQUENCE);

      expect(step.submitted).toBeNull();
      expect(step.buffer).toBe("baris satu\n");
    });

    it("submits the whole composed ask when Enter finally lands", () => {
      const composed = applyPaneInput("baris satu", META_ENTER_SEQUENCE).buffer;

      const step = applyPaneInput(composed, "baris dua\r");

      expect(step.submitted).toBe("baris satu\nbaris dua");
    });
  });

  describe("bracketed paste", () => {
    it("takes the pasted text without submitting on its newlines", () => {
      const step = applyPaneInput("review: ", `${PASTE_ON}satu\ndua${PASTE_OFF}`);

      expect(step.submitted).toBeNull();
      expect(step.buffer).toBe("review: satu\ndua");
    });

    it("submits when the Enter after the paste arrives", () => {
      const pasted = applyPaneInput("", `${PASTE_ON}jalankan test${PASTE_OFF}`).buffer;

      expect(applyPaneInput(pasted, "\r").submitted).toBe("jalankan test");
    });

    it("handles a paste and its Enter in one chunk", () => {
      const step = applyPaneInput("", `${PASTE_ON}jalankan test${PASTE_OFF}\r`);

      expect(step.submitted).toBe("jalankan test");
    });
  });

  it("caps the buffer so a huge paste cannot grow it without bound", () => {
    const step = applyPaneInput("", `${PASTE_ON}${"a".repeat(ASK_BUFFER_MAX * 2)}${PASTE_OFF}`);

    expect(step.buffer).toHaveLength(ASK_BUFFER_MAX);
  });

  it("trims the submitted ask", () => {
    expect(applyPaneInput("", "  halo  \r").submitted).toBe("halo");
  });
});

describe("createPaneAskBuffer", () => {
  it("keeps one line per pane", () => {
    const buffers = createPaneAskBuffer();

    buffers.note("a1", "halo");
    buffers.note("a2", "selamat");

    expect(buffers.note("a1", " dunia\r")).toBe("halo dunia");
    expect(buffers.note("a2", " pagi\r")).toBe("selamat pagi");
  });

  it("returns null while the line is still being typed", () => {
    const buffers = createPaneAskBuffer();

    expect(buffers.note("a1", "hal")).toBeNull();
  });

  it("forgets a pane that closed", () => {
    // Panes are reopened and reused. Carrying a half-typed line across would attribute the previous
    // occupant's words to the new one.
    const buffers = createPaneAskBuffer();
    buffers.note("a1", "setengah");

    buffers.clear("a1");

    expect(buffers.note("a1", "jadi\r")).toBe("jadi");
  });
});

describe("suspend — Lotus talking to the CLI is not an ask", () => {
  // Found live on 2026-08-26, on the very first Codex pane this feature reached. Its headline read
  // "You may guide the user's view — lotus_focus_cell to pan/zoom to a node, …" — the canvas persona
  // preamble, not anything the operator asked for.
  //
  // Cause, from `live-agent-spawn.ts:62`: claude-family runners get their persona through
  // `--append-system-prompt`, a CLI flag that never touches the PTY. Runners without that flag —
  // codex, custom — have it **typed into the terminal** instead. So it arrives at the write choke
  // point looking exactly like a human submitting a prompt, on precisely the runners this whole
  // slice was built to cover.
  //
  // The launch controller types three things and only one is an ask: `spec.command` (the shell line
  // that starts the CLI), `spec.bootstrapText` (the persona), and `spec.submitText` (the operator's
  // task). The first two must not title anything, so the caller brackets its launch writes and
  // records the real task explicitly, from the spec, rather than scraping it back out of the stream.

  it("swallows a whole submitted line while suspended", () => {
    const buffers = createPaneAskBuffer();

    buffers.suspend("a1");
    const submitted = buffers.note("a1", "You may guide the user's view — lotus_focus_cell …\r");

    expect(submitted).toBeNull();
  });

  it("leaves nothing behind for the next real ask to inherit", () => {
    // The delayed Enter of a submit queue can land AFTER the bracket closes. If the suspended text
    // had been buffered, that stray Enter would submit the persona anyway.
    const buffers = createPaneAskBuffer();
    buffers.suspend("a1");
    buffers.note("a1", "persona preamble");
    buffers.resume("a1");

    expect(buffers.note("a1", "\r")).toBeNull();
    expect(buffers.note("a1", "jalankan test\r")).toBe("jalankan test");
  });

  it("captures again once resumed", () => {
    const buffers = createPaneAskBuffer();
    buffers.suspend("a1");
    buffers.resume("a1");

    expect(buffers.note("a1", "halo\r")).toBe("halo");
  });

  it("counts, so overlapping launch writes cannot re-open capture early", () => {
    const buffers = createPaneAskBuffer();
    buffers.suspend("a1");
    buffers.suspend("a1");

    buffers.resume("a1");
    expect(buffers.note("a1", "masih launch\r")).toBeNull();

    buffers.resume("a1");
    expect(buffers.note("a1", "sekarang nyata\r")).toBe("sekarang nyata");
  });

  it("never drops below zero, so a stray resume cannot disable capture", () => {
    const buffers = createPaneAskBuffer();

    buffers.resume("a1");
    buffers.suspend("a1");
    buffers.resume("a1");

    expect(buffers.note("a1", "halo\r")).toBe("halo");
  });

  it("suspends one pane only", () => {
    const buffers = createPaneAskBuffer();

    buffers.suspend("a1");

    expect(buffers.note("a2", "halo\r")).toBe("halo");
  });

  it("forgets a suspension when the pane closes, so a reopened pane is not deaf", () => {
    const buffers = createPaneAskBuffer();
    buffers.suspend("a1");

    buffers.clear("a1");

    expect(buffers.note("a1", "halo\r")).toBe("halo");
  });
});


/**
 * Clicking inside a pane must not type into the ask. Mouse tracking sends reports back UP the PTY,
 * through the same write choke point a human's keystrokes use — so every click, drag and release
 * landed in the buffer and then in the session title (`<0;50;20M<0;50;20m…`, seen live 2026-09-14).
 */
describe("mouse reports are not text", () => {
  it("drops SGR mouse reports, which open with a private parameter byte", () => {
    const step = applyPaneInput("", `${ESC}[<0;50;20M${ESC}[<0;50;20m`);
    expect(step.buffer).toBe("");
    expect(step.submitted).toBeNull();
  });

  it("keeps a real ask typed around a click", () => {
    const step = applyPaneInput("", `hal${ESC}[<0;50;20Mo${ESC}[<0;50;20m\r`);
    expect(step.submitted).toBe("halo");
  });

  it("drops X10 mouse reports together with their three raw bytes", () => {
    const step = applyPaneInput("", `${ESC}[M !"halo`);
    expect(step.buffer).toBe("halo");
  });

  it("a click followed by Enter submits nothing at all", () => {
    const step = applyPaneInput("", `${ESC}[<0;41;21M${ESC}[<0;41;21m\r`);
    expect(step.submitted).toBeNull();
  });
});
