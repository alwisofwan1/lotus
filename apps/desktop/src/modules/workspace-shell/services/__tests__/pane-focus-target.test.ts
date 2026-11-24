import { describe, expect, it } from "vitest";
import { keepsChordForTyping, paneFocusTarget } from "@/modules/workspace-shell/services/pane-focus-target";

function pane(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  return element;
}

describe("paneFocusTarget", () => {
  /**
   * xterm types through a hidden helper textarea, and that element is the only one whose keystrokes
   * reach the PTY. It wins over anything else the pane happens to contain — the search bar, an
   * inline suggestion box — because landing anywhere else means the agent never hears you.
   */
  it("gives a terminal pane its xterm helper textarea, ahead of any other field", () => {
    const element = pane(`
      <input class="terminal-search" />
      <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
    `);

    expect(paneFocusTarget(element)).toBe(element.querySelector(".xterm-helper-textarea"));
  });

  /**
   * A conversation pane should land on the box you type the message in. The markup mirrors the real
   * `ChatInput`: a file picker sits in the same subtree, hidden by a class rather than by the
   * `hidden` attribute, so it cannot be ruled out by looks — only by being a file input.
   */
  it("gives a conversation pane its composer, not the hidden file picker", () => {
    const element = pane(`
      <input type="file" multiple accept="image/*" class="hidden" />
      <textarea class="composer" placeholder="Ask anything"></textarea>
    `);

    expect(paneFocusTarget(element)).toBe(element.querySelector("textarea.composer"));
  });

  /**
   * A browser pane has nothing to type into — the page runs in a native webview, outside this DOM.
   * The pane element itself is the answer, so the cursor at least LEAVES the pane it was in. That
   * matters more than it sounds: without it, ⌘⌥→ onto a browser pane would move the highlight while
   * the next thing typed still went to the agent behind it.
   */
  it("falls back to the pane itself when there is nothing to type into", () => {
    const element = pane(`<div class="browser-surface"></div>`);

    expect(paneFocusTarget(element)).toBe(element);
  });

  it("skips a field that cannot take focus", () => {
    const element = pane(`<textarea disabled></textarea>`);

    expect(paneFocusTarget(element)).toBe(element);
  });

});

describe("keepsChordForTyping", () => {
  /**
   * ⌘⇧← extends a selection to the start of the line in any ordinary field, and the shell has a
   * composer at the bottom of every screen. Taking that key from someone mid-sentence to move a
   * pane is a worse trade than the shortcut is worth.
   */
  it.each([
    ["a composer", "<textarea class='composer'></textarea>", "textarea"],
    ["a text box", "<input type='text' />", "input"],
    ["a rich editor", "<div contenteditable='true'></div>", "div"],
  ])("leaves a selection chord to %s", (_label, html, selector) => {
    const element = pane(html);

    expect(keepsChordForTyping(element.querySelector(selector))).toBe(true);
  });

  /**
   * A terminal is the exception, and the reason the question is asked of the DOM at all: xterm
   * types through a textarea, so the blunt "is this a field" test would disable every focus key
   * exactly where it is used most. CodeSpace carves out the same element for ⌘W
   * (`shouldIgnorePaneCloseShortcutTarget`).
   */
  it("claims the chord back inside a terminal", () => {
    const element = pane(`<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`);

    expect(keepsChordForTyping(element.querySelector("textarea"))).toBe(false);
  });

  it("claims the chord when nothing is focused", () => {
    expect(keepsChordForTyping(null)).toBe(false);
  });
});
