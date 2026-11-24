import { describe, it, expect, vi } from "vitest";
import { createFleetOutputTap, detectProviderFromOutput, extractLastLine } from "../fleet-output-tap";
import { createCellBus } from "../cell-event-bus";

// What Lotus's shell integration prints right before a typed command runs.
const CMD_START = "\x1b]133;B\x07\x1b]133;C\x07";

describe("detectProviderFromOutput", () => {
  it("detects Claude from 'Claude Code' banner", () => {
    expect(detectProviderFromOutput("Welcome to Claude Code")).toBe("claude");
  });

  it("detects Claude from '? for shortcuts' prompt line", () => {
    expect(detectProviderFromOutput("bash-3.2$ ? for shortcuts")).toBe("claude");
  });

  it("detects Codex from banner text", () => {
    expect(detectProviderFromOutput("Running codex v0.5 …")).toBe("codex");
  });

  it("detects Codex, not Claude, when Codex's footer also shows '? for shortcuts'", () => {
    expect(detectProviderFromOutput(">_ OpenAI Codex (v0.169.0)\n› Ask Codex to do anything\n? for shortcuts")).toBe("codex");
  });

  it("detects Codex from its composer when the banner has scrolled out (live capture)", () => {
    expect(detectProviderFromOutput("⠈⠙⠛⠿⠿⠿⠿⠛⠉           › Ask Codex to do anything   ? for shortcuts ")).toBe("codex");
  });

  it("detects Grok from its build footer (live capture)", () => {
    expect(detectProviderFromOutput("Grok 4.7 (high) · always-approve\n  Grok Build  1.0.77 [stable]")).toBe("grok");
  });

  it("detects Pi before the codex backend in its footer (live capture)", () => {
    expect(detectProviderFromOutput(" Pi can explain its own features and look up its docs.\n (openai-codex) gpt-5.6-terra • medium")).toBe("pi");
  });

  it("detects Antigravity before the Gemini model in its footer (live capture)", () => {
    expect(detectProviderFromOutput(" Welcome to the Antigravity CLI.\n  ↑/↓ Navigate · enter ConfirmGemini 3.8 Flash · medium")).toBe("antigravity");
  });

  it("detects Cursor from its splash (live capture)", () => {
    expect(detectProviderFromOutput("\x1b[1mCursor Agent\x1b[22m\r\n          \x1b[2mv2026.10.01-e373342\x1b[22m\r\n  \x1b[32mPress any key to log in...\x1b[39m")).toBe("cursor");
    expect(detectProviderFromOutput("the Cursor Agent v2 docs say")).toBeNull();
  });

  it("detects Gemini from prompt", () => {
    expect(detectProviderFromOutput("Gemini CLI — Google")).toBe("gemini");
  });

  it("detects OpenCode", () => {
    expect(detectProviderFromOutput("OpenCode assistant ready")).toBe("opencode");
  });

  it("detects Cursor CLI", () => {
    expect(detectProviderFromOutput("cursor-agent --chat")).toBe("cursor");
  });

  it("detects GitHub Copilot", () => {
    expect(detectProviderFromOutput("GitHub Copilot chat>")).toBe("copilot");
  });

  it("returns null for unrelated output", () => {
    expect(detectProviderFromOutput("$ ls -la\n$ pwd\n")).toBe(null);
  });

  it("is case-insensitive", () => {
    expect(detectProviderFromOutput("CLAUDE CODE WELCOME")).toBe("claude");
  });

  it("strips ANSI before matching", () => {
    expect(detectProviderFromOutput("\x1b[32mClaude Code\x1b[0m welcome")).toBe("claude");
  });
});

describe("extractLastLine", () => {
  it("returns the last non-empty line", () => {
    expect(extractLastLine("foo\nbar\nbaz\n")).toBe("baz");
  });

  it("skips empty/whitespace-only trailing lines", () => {
    expect(extractLastLine("foo\nbar\n   \n\n")).toBe("bar");
  });

  it("strips ANSI sequences", () => {
    expect(extractLastLine("\x1b[31mred line\x1b[0m\n")).toBe("red line");
  });

  it("trims carriage returns", () => {
    expect(extractLastLine("progress 50%\rprogress 100%\r\n")).toBe("progress 100%");
  });

  it("returns empty string for all-blank input", () => {
    expect(extractLastLine("   \n\n\t\n")).toBe("");
  });

  it("truncates long lines", () => {
    const long = "x".repeat(200);
    expect(extractLastLine(long).length).toBeLessThanOrEqual(120);
  });
});

describe("createFleetOutputTap", () => {
  it("records last line and detected provider per pane from bus events", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);

    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code welcome\n> " });
    bus.emit("terminal:output", { paneId: "p2", workspaceId: "w", data: "$ ls\nfile.txt\n" });

    expect(tap.getDetectedProvider("p1")).toBe("claude");
    expect(tap.getDetectedProvider("p2")).toBe(null);
    expect(tap.getLastLine("p1")).toBe(">");
    expect(tap.getLastLine("p2")).toBe("file.txt");
    tap.dispose();
  });

  it("a loose guess never overrules the launch: Pi's footer \"(openai-codex)\" stays Pi", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    // Pi redraws only its footer after a reattach; its banner is not in the buffer.
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "$0.000 (sub) 0.0%/272k (auto)  (openai-codex) gpt-5.6-terra · medium" });

    expect(tap.getDetectedProvider("p1", "pi")).toBe(null);
    expect(tap.getDetectedProvider("p1", "codex")).toBe("codex");
    expect(tap.getDetectedProvider("p1")).toBe("codex"); // a plain shell keeps the loose guess
    tap.dispose();
  });

  it("a CLI's own banner overrules the launch command after a relaunch", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code welcome\n> " });
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: CMD_START });
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: ">_ OpenAI Codex (v0.169.0)\n" });

    expect(tap.getDetectedProvider("p1", "claude")).toBe("codex");
    tap.dispose();
  });

  it("another CLI's banner quoted in a reply never overrules the launch: Pi saying \"Claude Code\" stays Pi", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    // Live 2026-11-24: Pi's banner was not in the buffer, its reply was.
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Saya Claude Code, asisten coding.\n" });

    expect(tap.getDetectedProvider("p1", "pi")).toBe(null);
    // A launcher with no banner of its own still takes the banner of the CLI it runs.
    expect(tap.getDetectedProvider("p1", "ccs hss")).toBe("claude");
    tap.dispose();
  });

  it("notifies subscribers on changes", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    const listener = vi.fn();
    tap.subscribe(listener);

    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "hello\n" });
    expect(listener).toHaveBeenCalled();
    tap.dispose();
  });

  it("an agent typed into a shell ends when the shell's next prompt arrives (OSC 133;D)", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    const emit = (data: string) => bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data });

    emit("\x1b]133;D;0\x07\x1b]133;A\x07$ "); // the shell's first prompt: nothing has ended
    expect(tap.takeEndedAgents()).toEqual([]);
    emit(">_ OpenAI Codex (v0.169.0)\n› Ask Codex to do anything");
    expect(tap.getDetectedProvider("p1")).toBe("codex");

    emit("Token usage: total=30\n\x1b]133;D;0\x07\x1b]133;A\x07$ ");
    expect(tap.getDetectedProvider("p1")).toBe(null);
    expect(tap.takeEndedAgents()).toEqual(["p1"]);
    expect(tap.takeEndedAgents()).toEqual([]);

    emit("$ ls\nfile.txt\n"); // the old banner is gone with the agent
    expect(tap.getDetectedProvider("p1")).toBe(null);
    emit("Claude Code v2\n");
    expect(tap.getDetectedProvider("p1")).toBe("claude");
    tap.dispose();
  });

  it("clears state on terminal:exited", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code\n" });
    expect(tap.getDetectedProvider("p1")).toBe("claude");

    bus.emit("terminal:exited", { paneId: "p1", workspaceId: "w" });
    expect(tap.getDetectedProvider("p1")).toBe(null);
    expect(tap.getLastLine("p1")).toBe("");
    tap.dispose();
  });

  it("detects provider from delta after buffer accumulates", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "foo\nbar\n" });
    expect(tap.getDetectedProvider("p1")).toBe(null);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "now running codex v1\n" });
    expect(tap.getDetectedProvider("p1")).toBe("codex");
    tap.dispose();
  });

  it("(04) re-detects a provider switch when a strong launch banner appears", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code welcome\n> " });
    expect(tap.getDetectedProvider("p1")).toBe("claude");
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: CMD_START }); // codex typed at the prompt

    // Live symptom this reproduces: `>_ OpenAI Codex (v0.154.0)` printed in a pane still
    // labeled "claude".
    bus.emit("terminal:output", {
      paneId: "p1",
      workspaceId: "w",
      data: ">_ OpenAI Codex (v0.154.0)\n",
    });
    expect(tap.getDetectedProvider("p1")).toBe("codex");
    tap.dispose();
  });

  it("(04) ordinary output after a switch does not revert or clear the label", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code welcome\n> " });
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: CMD_START }); // codex typed at the prompt
    bus.emit("terminal:output", {
      paneId: "p1",
      workspaceId: "w",
      data: ">_ OpenAI Codex (v0.154.0)\n",
    });
    expect(tap.getDetectedProvider("p1")).toBe("codex");

    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "$ ls\nfile.txt\n" });
    expect(tap.getDetectedProvider("p1")).toBe("codex");
    tap.dispose();
  });

  // (04) The most important test in this task: an agent's reply merely CONTAINING the word
  // "codex" must not trigger a false switch — everyone working in this repo types it
  // routinely, and a false switch reallocates the address out from under the pane.
  it("(04) an agent's reply merely containing the word 'codex' does not trigger a false switch", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code welcome\n> " });
    expect(tap.getDetectedProvider("p1")).toBe("claude");

    bus.emit("terminal:output", {
      paneId: "p1",
      workspaceId: "w",
      data: "Sure — I'll wire this up the same way codex does it in the other repo.\n",
    });
    expect(tap.getDetectedProvider("p1")).toBe("claude");
    tap.dispose();
  });

  it("a running agent printing banner text (a diff of this file) does not relabel the pane", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code v2.1\n> " });
    // 2026-11-17: Claude showed an edit to output_tail.rs and the pane turned into Codex.
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: '   ("OpenAI Codex", "codex"),\n+  ("Ask Codex to do anything", "codex"),\n' });
    expect(tap.getDetectedProvider("p1")).toBe("claude");
    tap.dispose();
  });

  it("(04 follow-up) a launch banner split across two PTY chunks still triggers the switch", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code welcome\n> " });
    expect(tap.getDetectedProvider("p1")).toBe("claude");

    // Live evidence chunks split mid-word here (fleet previews the same day showed "canel"
    // from "cancel", "aces.\"," from "workspaces.\","), so "OpenAI Codex" splitting the same
    // way is not hypothetical.
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: CMD_START }); // codex typed at the prompt
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: ">_ OpenAI Co" });
    expect(tap.getDetectedProvider("p1")).toBe("claude"); // banner incomplete — no switch yet
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "dex (v0.154.0)\n" });
    expect(tap.getDetectedProvider("p1")).toBe("codex");
    tap.dispose();
  });

  it("(04 follow-up) a banner that has scrolled out of the small switch window does not re-trigger", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code welcome\n> " });
    expect(tap.getDetectedProvider("p1")).toBe("claude");
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: CMD_START }); // codex typed at the prompt

    bus.emit("terminal:output", {
      paneId: "p1",
      workspaceId: "w",
      data: ">_ OpenAI Codex (v0.154.0)\n",
    });
    expect(tap.getDetectedProvider("p1")).toBe("codex");

    // Push the codex banner text well outside the small switch window with unrelated
    // filler — unlike the old full-4KB buffer, which would have kept re-matching it for
    // thousands more bytes and caused exactly the flip-flop this window bound prevents.
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "x".repeat(300) });
    expect(tap.getDetectedProvider("p1")).toBe("codex");

    // A LEGITIMATE second switch, back to claude, must still work — the window bound only
    // stops a STALE banner from re-matching, it doesn't freeze the label.
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: CMD_START });
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code resumed\n> " });
    expect(tap.getDetectedProvider("p1")).toBe("claude");

    // Ordinary output after that must not flip it back to codex just because "OpenAI
    // Codex" appeared several chunks ago.
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "$ ls\nfile.txt\n" });
    expect(tap.getDetectedProvider("p1")).toBe("claude");
    tap.dispose();
  });

  it("returns the plain text output tail capped by line count", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);

    bus.emit("terminal:output", {
      paneId: "p1",
      workspaceId: "w",
      data: "\x1b[32mfirst\x1b[0m\nsecond\nthird\n",
    });

    expect(tap.getTail("p1", 2)).toBe("second\nthird");
    tap.dispose();
  });

  it("dispose() unsubscribes from bus", () => {
    const bus = createCellBus();
    const tap = createFleetOutputTap(bus);
    tap.dispose();
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w", data: "Claude Code\n" });
    expect(tap.getDetectedProvider("p1")).toBe(null);
  });
});

describe("charset-designation escapes", () => {
  it("drops ESC ( B, which a Claude pane emits and which otherwise becomes the whole preview", () => {
    // Observed 2026-09-10 in a live Swarm fleet snapshot: every member's preview read "(B".
    // ESC ( B selects the ASCII charset; it is two bytes after ESC, so the single-char ESC branch
    // of the strip regex never matched it.
    expect(extractLastLine("? for shortcuts\r\n\x1b(B")).toBe("? for shortcuts");
    // The exact tail read off a live Claude pane: charset escape plus SI (shift-in, 0x0f).
    expect(extractLastLine("? for shortcuts\r\n\x1b(B\x0f")).toBe("? for shortcuts");
    expect(extractLastLine("\x0e\x0fplain")).toBe("plain");
    expect(extractLastLine("\x1b(Bhello")).toBe("hello");
    expect(extractLastLine("\x1b)0graphics")).toBe("graphics");
  });
});
