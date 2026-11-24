import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnifiedComposer } from "../UnifiedComposer";
import { voiceStopHint } from "../composer-voice-parts";

function renderComposer(overrides: Partial<React.ComponentProps<typeof UnifiedComposer>> = {}) {
  const props = {
    target: { kind: "terminal" as const, label: "interview-hss" },
    placeholder: "Message interview-hss",
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<UnifiedComposer {...props} />);
  return props;
}

describe("UnifiedComposer", () => {
  it("keeps send and dictate beside the field, not on a row of their own", () => {
    renderComposer();
    const actions = screen.getByRole("button", { name: "Send" }).closest(".ws-composer-input");
    expect(actions).not.toBeNull();
  });

  it("drops the second row entirely when there is nothing to put in it", () => {
    renderComposer();
    // A terminal has no model, no effort and no attachments: that row was a spacer and two
    // buttons' worth of empty height.
    expect(document.querySelector(".ws-composer-controls")).toBeNull();
    expect(document.querySelector(".ws-composer")?.getAttribute("data-empty")).toBe("true");
  });

  it("keeps the second row when a control actually lives there", () => {
    renderComposer({ showAttach: true });
    expect(document.querySelector(".ws-composer-controls")).not.toBeNull();
    expect(document.querySelector(".ws-composer")?.getAttribute("data-empty")).toBeNull();
  });

  it("refuses to send an empty or whitespace-only message", () => {
    const props = renderComposer();
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Send to interview-hss"), { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("sends on Enter and clears the box, so the same text cannot go twice", () => {
    const props = renderComposer();
    const field = screen.getByLabelText("Send to interview-hss") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "ls -la" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledWith("ls -la");
    expect(field.value).toBe("");
  });

  it("breaks the line on Shift+Enter instead of sending", () => {
    const props = renderComposer();
    const field = screen.getByLabelText("Send to interview-hss");
    fireEvent.change(field, { target: { value: "baris" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("names the pane a kept turn was spoken for, with a lock, while focus is elsewhere", () => {
    renderComposer({ target: { kind: "terminal", label: "Rani", locked: true } });
    const target = screen.getByTitle("Kept for Rani — Enter sends there");
    expect(target.textContent).toContain("Rani");
    expect(target.querySelector("[data-lock]")).not.toBeNull();
  });

  it("tells the caller when the field empties and fills, so a kept target can let go", () => {
    const onEmptyChange = vi.fn();
    renderComposer({ onEmptyChange });
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "hi" } });
    fireEvent.change(field, { target: { value: "hi there" } });
    fireEvent.change(field, { target: { value: "" } });
    expect(onEmptyChange.mock.calls).toEqual([[false], [true]]);
  });

  it("does not report the field empty while ⌘K holds its text aside", () => {
    const onEmptyChange = vi.fn();
    const sheet = {
      open: false, focusSignal: 0, query: "", activeIndex: 0, ranked: { items: [] },
      onInput: vi.fn(), onMove: vi.fn(), onHover: vi.fn(), close: vi.fn(), run: vi.fn(), runActive: vi.fn(),
    } as unknown as NonNullable<React.ComponentProps<typeof UnifiedComposer>["sheet"]>;
    const props = { target: { kind: "terminal" as const, label: "Rani" }, placeholder: "Type", onSubmit: vi.fn(), onEmptyChange };
    const { rerender } = render(<UnifiedComposer {...props} sheet={sheet} />);
    fireEvent.change(screen.getByLabelText("Send to Rani"), { target: { value: "fix the test" } });
    onEmptyChange.mockClear();
    rerender(<UnifiedComposer {...props} sheet={{ ...sheet, open: true, focusSignal: 1 }} />);
    expect(onEmptyChange).not.toHaveBeenCalled();
  });

  it("says why it cannot send, in place of the field", () => {
    renderComposer({ disabledReason: "That pane is not ready." });
    expect(screen.getByText("That pane is not ready.")).toBeTruthy();
    expect(screen.queryByLabelText("Send to interview-hss")).toBeNull();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("UnifiedComposer — Push-to-Talk", () => {
  const voice = (phase: "idle" | "recording" | "transcribing" = "idle", interim = "") => ({ phase, interim, onToggle: vi.fn() });

  it("draws no Dictate button when voice is not wired, so it never sits there doing nothing", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("starts and stops Push-to-Talk from the Dictate button", () => {
    const v = voice();
    const { rerender } = render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={v} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    expect(v.onToggle).toHaveBeenCalledOnce();
    rerender(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={{ ...v, phase: "recording", interim: "fix the" }} />);
    const stop = screen.getByRole("button", { name: "Stop dictating" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(stop);
    expect(v.onToggle).toHaveBeenCalledTimes(2);
  });

  it("keeps Dictate beside Send once there is text", () => {
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={{ ...voice(), hotkey: "⌥⇧Space" }} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dictate" }).getAttribute("title")).toBe("Dictate — hold ⌥⇧Space, or click");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides Dictate only while the command sheet is open", () => {
    const sheet = { open: true, focusSignal: 0, ranked: { items: [] }, activeIndex: 0, query: "", onHover: vi.fn(), onMove: vi.fn(), onInput: vi.fn(), close: vi.fn(), run: vi.fn(), runActive: vi.fn() };
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={voice()} sheet={sheet as never} />);
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
    expect(screen.getByText("Command")).toBeTruthy();
  });

  it("offers Live Voice only while the field is empty, naming its key", () => {
    const onStart = vi.fn();
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={voice()} liveVoice={{ hotkey: "⌘⇧L", onStart }} />);
    const live = screen.getByRole("button", { name: "Live Voice" });
    expect(live.getAttribute("title")).toBe("Talk with Lotus — ⌘⇧L");
    fireEvent.click(live);
    expect(onStart).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    expect(screen.queryByRole("button", { name: "Live Voice" })).toBeNull();
  });

  it("draws Dictate as unavailable, not hidden, when no voice provider is set", () => {
    const v = { ...voice(), available: false };
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={v} />);
    const mic = screen.getByRole("button", { name: "Dictate" });
    expect(mic.getAttribute("data-unavailable")).toBe("true");
    expect(mic.getAttribute("title")).toBe("Dictate — needs a voice provider in Settings › Voice");
    fireEvent.click(mic);
    expect(v.onToggle).toHaveBeenCalledOnce();
  });

  it("says how a held turn stops: let go of the key", () => {
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={{ ...voice("recording"), hotkey: "⌥⇧Space", held: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Release ⌥⇧Space to finish ·");
  });

  it("says how a tapped turn stops: press again or ✓", () => {
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={{ ...voice("recording"), hotkey: "⌥⇧Space" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Press ⌥⇧Space again or ✓ to finish ·");
  });

  it("says ✓ alone when the Push-to-Talk key is unbound", () => {
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={voice("recording")} />);
    expect(screen.getByRole("status")).toHaveTextContent("Press ✓ to finish ·");
  });

  it("names ⌘Enter and Esc after how the turn stops, with this platform's keys", () => {
    expect(voiceStopHint({ held: true, hotkey: "⌥⇧Space" }, "mac")).toBe("Release ⌥⇧Space to finish · ⌘Enter finishes and sends · Esc cancels");
    expect(voiceStopHint({ hotkey: "Alt+Shift+Space" }, "other")).toBe("Press Alt+Shift+Space again or ✓ to finish · Ctrl+Enter finishes and sends · Esc cancels");
  });

  it("says nothing of how to stop while the mic is still opening", () => {
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={{ ...voice(), phase: "starting", hotkey: "⌥⇧Space" }} />);
    expect(screen.queryByText(/to finish/)).toBeNull();
  });

  it("offers Live Voice without Send in an empty field, even with no mic", () => {
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} liveVoice={{ onStart: vi.fn() }} />);
    expect(screen.getByRole("button", { name: "Live Voice" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("shows what is heard as text after what was typed, not as a placeholder", () => {
    const props = { target: null, placeholder: "Type", onSubmit: vi.fn() };
    const { rerender } = render(<UnifiedComposer {...props} voice={voice()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "please" } });
    rerender(<UnifiedComposer {...props} voice={voice("recording", "run the tests")} />);
    const live = document.querySelector(".ws-composer-live");
    expect(live?.textContent).toBe("please run the tests");
    rerender(<UnifiedComposer {...props} voice={voice("transcribing")} />);
    expect(document.querySelector(".ws-composer-live")?.textContent).toBe("please run the tests");
    expect(screen.getByRole("img", { name: "Transcribing" })).toBeTruthy();
  });

  it("cancels the turn from the listening row", () => {
    const onCancel = vi.fn();
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={{ ...voice("recording"), onCancel }} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(document.querySelector(".ws-composer")?.getAttribute("data-voice")).toBe("recording");
  });

  it("hands the root to the level target, for the mic level to draw on", () => {
    const levelTarget = vi.fn();
    render(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={{ ...voice(), levelTarget }} />);
    expect(levelTarget).toHaveBeenCalledWith(document.querySelector(".ws-composer"));
  });

  it("adds a held spoken turn after what was already typed", () => {
    const props = { target: null, placeholder: "Type", onSubmit: vi.fn(), voice: voice() };
    const { rerender } = render(<UnifiedComposer {...props} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "please" } });
    rerender(<UnifiedComposer {...props} insert={{ text: "run the tests", seq: 1 }} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("please run the tests");
    rerender(<UnifiedComposer {...props} insert={{ text: "run the tests", seq: 1 }} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("please run the tests");
  });

  it("offers Undo after an automatic cleanup and puts back what was said", () => {
    const props = { target: null, placeholder: "Type", onSubmit: vi.fn(), voice: voice() };
    const { rerender } = render(<UnifiedComposer {...props} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "please" } });
    rerender(<UnifiedComposer {...props} insert={{ text: "Lotus Voice is ready.", spoken: "lotus voice is uh ready", seq: 1 }} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("please Lotus Voice is ready.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("please lotus voice is uh ready");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("drops Undo once the cleaned text was edited or sent", () => {
    const props = { target: null, placeholder: "Type", onSubmit: vi.fn(), voice: voice() };
    const { rerender } = render(<UnifiedComposer {...props} />);
    rerender(<UnifiedComposer {...props} insert={{ text: "Fix the bug.", spoken: "fix the bug", seq: 1 }} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix the other bug." } });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

    rerender(<UnifiedComposer {...props} insert={{ text: "Run it.", spoken: "run it", seq: 2 }} />);
    expect(screen.getByRole("status").textContent).toBe("Cleaned up by AI · Undo · Enter to send");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("offers no Undo when nothing was cleaned up", () => {
    const props = { target: null, placeholder: "Type", onSubmit: vi.fn(), voice: voice() };
    const { rerender } = render(<UnifiedComposer {...props} />);
    rerender(<UnifiedComposer {...props} insert={{ text: "run the tests", spoken: "run the tests", seq: 1 }} />);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("keeps held text visible with the reason when the pane cannot take it", () => {
    const props = { target: null, placeholder: "Type", disabledReason: "This terminal has no live session yet.", voice: voice() };
    const { rerender } = render(<UnifiedComposer {...props} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    rerender(<UnifiedComposer {...props} insert={{ text: "hello", seq: 1 }} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hello");
    expect(screen.getByRole("status").textContent).toBe("This terminal has no live session yet.");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("floats in a dock, so the panes above keep their height", () => {
    renderComposer({ floating: true });
    const dock = document.querySelector(".ws-composer-dock");
    expect(dock?.querySelector(".ws-composer")?.getAttribute("data-floating")).toBe("true");
  });

  it("shows the ⌘K hint only while the field is empty", () => {
    const sheet = {
      open: false, focusSignal: 0, query: "", activeIndex: 0, ranked: { items: [] },
      onInput: vi.fn(), onMove: vi.fn(), onHover: vi.fn(), close: vi.fn(), run: vi.fn(), runActive: vi.fn(),
    } as unknown as NonNullable<React.ComponentProps<typeof UnifiedComposer>["sheet"]>;
    renderComposer({ sheet });
    expect(document.querySelector(".ws-composer-kbd")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Send to interview-hss"), { target: { value: "x" } });
    expect(document.querySelector(".ws-composer-kbd")).toBeNull();
  });

  it("draws the waveform in the empty row, then beside the timer once words arrive", () => {
    const { container, rerender } = render(
      <UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={voice("recording")} />,
    );
    const inline = container.querySelector(".ws-composer-live .ws-voice-wave");
    expect(inline?.children).toHaveLength(28);
    expect((inline?.children[13] as HTMLElement).style.height).toContain("--voice-band-0");
    rerender(<UnifiedComposer target={null} placeholder="Type" onSubmit={vi.fn()} voice={voice("recording", "fix the")} />);
    expect(container.querySelector(".ws-composer-live .ws-voice-wave")).toBeNull();
    expect(container.querySelector(".ws-composer-actions .ws-voice-wave")).not.toBeNull();
  });

  it("shows a voice notice under the field", () => {
    renderComposer({ voice: voice(), notice: "Didn't catch that — try again." });
    expect(screen.getByRole("status").textContent).toBe("Didn't catch that — try again.");
  });
});

describe("UnifiedComposer — Held Prompt", () => {
  const held = (extra: Partial<NonNullable<React.ComponentProps<typeof UnifiedComposer>["heldPrompt"]>> = {}) => ({
    label: "Rani",
    seq: 1,
    onSend: vi.fn(),
    onClear: vi.fn(),
    ...extra,
  });
  const field = () => screen.getByLabelText("Send to interview-hss");

  it("says the text waits in the agent's prompt, and what Enter and Escape do", () => {
    renderComposer({ heldPrompt: held() });
    expect(screen.getByRole("status").textContent).toBe("In Rani's prompt · Enter to send · Esc to clear");
  });

  it("sends the Held Prompt on Enter while the field is empty, not the empty field", () => {
    const heldPrompt = held();
    const props = renderComposer({ heldPrompt });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(heldPrompt.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("clears the Held Prompt on Escape", () => {
    const heldPrompt = held();
    renderComposer({ heldPrompt });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(heldPrompt.onClear).toHaveBeenCalledTimes(1);
    expect(heldPrompt.onSend).not.toHaveBeenCalled();
  });

  it("says Enter sends both when a typed message goes to the agent holding the prompt", () => {
    renderComposer({ heldPrompt: held({ joinsMessage: true }) });
    fireEvent.change(field(), { target: { value: "also check lint" } });
    expect(screen.getByRole("status").textContent).toBe("In Rani's prompt · Enter sends both · Esc to clear");
  });

  it("leaves the Held Prompt alone while a message is typed: Enter sends the message", () => {
    const heldPrompt = held();
    const props = renderComposer({ heldPrompt });
    fireEvent.change(field(), { target: { value: "also check lint" } });
    expect(screen.getByRole("status").textContent).toBe("In Rani's prompt · Esc to clear");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(props.onSubmit).toHaveBeenCalledWith("also check lint");
    expect(heldPrompt.onSend).not.toHaveBeenCalled();
    expect(heldPrompt.onClear).not.toHaveBeenCalled();
  });

  it("says an AI cleanup happened, with no Undo once the text is in the agent's prompt", () => {
    renderComposer({ heldPrompt: held({ cleaned: true }) });
    expect(screen.getByRole("status").textContent).toBe("In Rani's prompt · Cleaned up by AI · Enter to send · Esc to clear");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("takes focus when a Held Prompt arrives, so Enter and Escape reach it", () => {
    renderComposer({ heldPrompt: held() });
    expect(document.activeElement).toBe(field());
  });
});

describe("UnifiedComposer — Live Voice", () => {
  const strip = {
    seq: 3,
    actions: 1,
    turns: [
      {
        turn: 1,
        lines: [
          { key: "u1", kind: "you" as const, text: "Spawn a reviewer", final: true },
          { key: "t1", kind: "tool" as const, text: "spawn_agent · Claude Code", ok: true },
          { key: "a1", kind: "lotus" as const, text: "Starting Claude Code.", final: true },
        ],
      },
    ],
  };
  function session(over: Partial<NonNullable<React.ComponentProps<typeof UnifiedComposer>["liveSession"]>> = {}) {
    return {
      active: true,
      phase: "listening" as const,
      agentSpeaking: false,
      providerName: "Grok",
      strip,
      onEnd: vi.fn(),
      onRetry: vi.fn(),
      ...over,
    };
  }
  function ui(props: Partial<React.ComponentProps<typeof UnifiedComposer>>) {
    return (
      <UnifiedComposer target={{ kind: "terminal", label: "Rowan" }} placeholder="Message Rowan" onSubmit={vi.fn()} {...props} />
    );
  }

  it("becomes the Live Voice state: → Lotus, what it is doing, and End", () => {
    const live = session();
    render(ui({ liveSession: live }));
    const row = document.querySelector(".ws-composer-input") as HTMLElement;
    expect(row.textContent).toContain("Lotus");
    expect(row.textContent).not.toContain("Rowan");
    expect(screen.getByRole("status").textContent).toBe("Listening…");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "End Live Voice" }));
    expect(live.onEnd).toHaveBeenCalled();
  });

  it("says barge-in works while Lotus speaks", () => {
    render(ui({ liveSession: session({ phase: "agent", agentSpeaking: true }) }));
    expect(screen.getByRole("status").textContent).toBe("Lotus is speaking — talk to interrupt");
  });

  it("offers Retry and Close on an error", () => {
    const live = session({ phase: "error", error: "Bad key" });
    render(ui({ liveSession: live }));
    expect(screen.getByRole("status").textContent).toBe("Bad key");
    fireEvent.click(screen.getByRole("button", { name: "Retry Live Voice" }));
    expect(live.onRetry).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close Live Voice" })).toBeTruthy();
  });

  it("shows the conversation strip above the composer, with the provider", () => {
    render(ui({ liveSession: session() }));
    const log = screen.getByRole("log", { name: "Live Voice conversation" });
    expect(log.textContent).toContain("Spawn a reviewer");
    expect(log.textContent).toContain("spawn_agent · Claude Code");
    expect(log.textContent).toContain("Live Voice · Grok");
  });

  it("stashes typed text while Live Voice runs and gives it back on End", () => {
    const { rerender } = render(ui({ liveSession: session({ active: false, phase: "idle" }) }));
    fireEvent.change(screen.getByLabelText("Send to Rowan"), { target: { value: "half a thought" } });
    rerender(ui({ liveSession: session() }));
    rerender(ui({ liveSession: session({ active: false, phase: "closed" }) }));
    expect((screen.getByLabelText("Send to Rowan") as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("leaves one dismissable summary line after End", () => {
    const { rerender } = render(ui({ liveSession: session({ active: false, phase: "idle" }) }));
    rerender(ui({ liveSession: session() }));
    rerender(ui({ liveSession: session({ active: false, phase: "closed" }) }));
    expect(screen.getByText(/^Live Voice · 1 action · \d:\d\d$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Live Voice summary" }));
    expect(screen.queryByText(/Live Voice · 1 action/)).toBeNull();
  });

  it("hides the summary on the next send", () => {
    const { rerender } = render(ui({ liveSession: session({ active: false, phase: "idle" }) }));
    rerender(ui({ liveSession: session() }));
    rerender(ui({ liveSession: session({ active: false, phase: "closed" }) }));
    const field = screen.getByLabelText("Send to Rowan");
    fireEvent.change(field, { target: { value: "next" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.queryByText(/Live Voice · 1 action/)).toBeNull();
  });
});
