import { describe, expect, it, vi } from "vitest";
import {
  isOpenableTerminalLink,
  activateTerminalWebLink,
  createTerminalOscLinkHandler,
} from "../terminal-web-links";

describe("terminal web links", () => {
  it("recognises openable external schemes (http/https/mailto/tel), case-insensitive", () => {
    expect(isOpenableTerminalLink("https://example.com")).toBe(true);
    expect(isOpenableTerminalLink("http://localhost:3000/x")).toBe(true);
    expect(isOpenableTerminalLink("HTTPS://EXAMPLE.COM")).toBe(true);
    expect(isOpenableTerminalLink("mailto:a@b.com")).toBe(true);
    expect(isOpenableTerminalLink("tel:+123")).toBe(true);
  });

  it("rejects non-external / unsupported schemes", () => {
    expect(isOpenableTerminalLink("ftp://host/f")).toBe(false);
    expect(isOpenableTerminalLink("file:///etc/hosts")).toBe(false);
    expect(isOpenableTerminalLink("javascript:alert(1)")).toBe(false);
    expect(isOpenableTerminalLink("not a url")).toBe(false);
    expect(isOpenableTerminalLink("")).toBe(false);
  });

  it("opens an openable link via the injected opener (the OS browser, not window.open)", () => {
    const open = vi.fn();
    expect(activateTerminalWebLink("  https://example.com  ", open)).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com"); // trimmed
  });

  it("OSC 8 handler opens the full URI via the opener and shows it as a tooltip on hover", () => {
    const open = vi.fn();
    const handler = createTerminalOscLinkHandler(open);
    const host = document.createElement("div");
    host.className = "xterm";
    const row = document.createElement("span");
    host.appendChild(row);
    const event = new MouseEvent("click", { cancelable: true });
    Object.defineProperty(event, "target", { value: row });
    const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 2 } };
    const uri = "https://github.com/o/r/issues/149#issuecomment-1";

    handler.hover?.(event, uri, range);
    expect(host.title).toBe(uri);
    handler.activate(event, uri, range);
    expect(open).toHaveBeenCalledWith(uri);
    expect(event.defaultPrevented).toBe(true);
    handler.leave?.(event, uri, range);
    expect(host.hasAttribute("title")).toBe(false);

    handler.activate(event, "javascript:alert(1)", range);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not open an unsupported link", () => {
    const open = vi.fn();
    expect(activateTerminalWebLink("javascript:alert(1)", open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
