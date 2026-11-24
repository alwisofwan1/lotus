import { describe, expect, it } from "vitest";
import { findNodeFocusTarget, isCodeEditorKeyTarget, isEditorWidgetOpen, isTerminalKeyTarget } from "./canvas-keyboard-guard";

describe("code editor target", () => {
  const editor = (inner = "") => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="monaco-editor">${inner}<textarea class="inputarea"></textarea></div>`;
    return root;
  };

  it("isCodeEditorKeyTarget is true only inside .monaco-editor", () => {
    const root = editor();
    expect(isCodeEditorKeyTarget(root.querySelector("textarea"))).toBe(true);
    expect(isCodeEditorKeyTarget(document.createElement("textarea"))).toBe(false);
    expect(isCodeEditorKeyTarget(null)).toBe(false);
  });

  it("isEditorWidgetOpen sees a visible find, suggest or rename widget, not a hidden one", () => {
    expect(isEditorWidgetOpen(editor())).toBe(false);
    expect(isEditorWidgetOpen(editor(`<div class="find-widget"></div>`))).toBe(false);
    expect(isEditorWidgetOpen(editor(`<div class="find-widget visible"></div>`))).toBe(true);
    expect(isEditorWidgetOpen(editor(`<div class="suggest-widget visible"></div>`))).toBe(true);
    expect(isEditorWidgetOpen(editor(`<div class="rename-box visible"></div>`))).toBe(true);
    expect(isEditorWidgetOpen(editor(`<div class="monaco-hover hidden"></div>`))).toBe(false);
    expect(isEditorWidgetOpen(editor(`<div class="monaco-hover"></div>`))).toBe(true);
  });
});

describe("isTerminalKeyTarget", () => {
  it("is true only inside an xterm terminal", () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    term.appendChild(helper);
    expect(isTerminalKeyTarget(helper)).toBe(true);
    expect(isTerminalKeyTarget(term)).toBe(true);
    expect(isTerminalKeyTarget(document.createElement("input"))).toBe(false);
    expect(isTerminalKeyTarget(null)).toBe(false);
  });
});

describe("findNodeFocusTarget", () => {
  it("prefers the terminal helper textarea, then any editable control", () => {
    const withTerm = document.createElement("div");
    withTerm.innerHTML = `<input /><textarea class="xterm-helper-textarea"></textarea>`;
    expect(findNodeFocusTarget(withTerm)).toBe(withTerm.querySelector(".xterm-helper-textarea"));

    const withInput = document.createElement("div");
    withInput.innerHTML = `<button>x</button><input class="pick" />`;
    expect(findNodeFocusTarget(withInput)).toBe(withInput.querySelector(".pick"));

    const withNothing = document.createElement("div");
    withNothing.innerHTML = `<button>x</button>`;
    expect(findNodeFocusTarget(withNothing)).toBeNull();
  });
});
