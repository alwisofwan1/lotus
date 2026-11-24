import { describe, expect, it } from "vitest";
import { createTerminalLinkClickGuard, normalizeTerminalLink, parseTerminalPathReference } from "../terminal-links";

describe("normalizeTerminalLink", () => {
  it("accepts supported external link schemes", () => {
    expect(normalizeTerminalLink("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(normalizeTerminalLink("mailto:test@example.com")).toBe("mailto:test@example.com");
    expect(normalizeTerminalLink("tel:+62-812-3456-7890")).toBe("tel:+62-812-3456-7890");
  });

  it("rejects unsupported schemes", () => {
    expect(normalizeTerminalLink("javascript:alert(1)")).toBeNull();
    expect(normalizeTerminalLink("file:///tmp/demo.txt")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTerminalLink("  https://example.com  ")).toBe("https://example.com/");
  });

  it("normalizes localhost links without a scheme to http", () => {
    expect(normalizeTerminalLink("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeTerminalLink("127.0.0.1:5173/docs")).toBe("http://127.0.0.1:5173/docs");
  });
});

describe("parseTerminalPathReference", () => {
  it("parses relative file paths with line and column", () => {
    expect(parseTerminalPathReference("src/lib/terminal-addons.ts:60:12")).toEqual({
      path: "src/lib/terminal-addons.ts",
      line: 60,
      column: 12,
      text: "src/lib/terminal-addons.ts:60:12",
    });
  });

  it("parses absolute file paths", () => {
    expect(parseTerminalPathReference("/tmp/debug.log:12")).toEqual({
      path: "/tmp/debug.log",
      line: 12,
      column: undefined,
      text: "/tmp/debug.log:12",
    });
  });

  it("rejects values that are not path references", () => {
    expect(parseTerminalPathReference("Error: listen EADDRINUSE: address already in use :::3000")).toBeNull();
    expect(parseTerminalPathReference("localhost:3000")).toBeNull();
  });
});

describe("createTerminalLinkClickGuard", () => {
  const press = (el: HTMLElement, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent("mousedown", { clientX: 10, clientY: 10, ...init }));
  const up = (init: MouseEventInit = {}) => new MouseEvent("mouseup", { clientX: 10, clientY: 10, detail: 1, ...init });

  it("opens on a plain stationary left click", () => {
    const el = document.createElement("div");
    const guard = createTerminalLinkClickGuard(el);
    press(el);
    expect(guard.allows(up())).toBe(true);
  });

  it("ignores right/middle click, modified clicks, and double-clicks", () => {
    const el = document.createElement("div");
    const guard = createTerminalLinkClickGuard(el);
    for (const init of [{ button: 2 }, { button: 1 }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { detail: 2 }]) {
      press(el, init);
      expect(guard.allows(up(init))).toBe(false);
    }
  });

  it("ignores a drag-select that ends on the same link, and any click that leaves text selected", () => {
    const el = document.createElement("div");
    let selected = false;
    const guard = createTerminalLinkClickGuard(el, () => selected);
    press(el);
    expect(guard.allows(up({ clientX: 40 }))).toBe(false);
    selected = true;
    press(el);
    expect(guard.allows(up())).toBe(false);
  });

  it("stops tracking presses once disposed", () => {
    const el = document.createElement("div");
    const guard = createTerminalLinkClickGuard(el);
    guard.dispose();
    press(el, { clientX: 100 });
    expect(guard.allows(up())).toBe(true);
  });
});
