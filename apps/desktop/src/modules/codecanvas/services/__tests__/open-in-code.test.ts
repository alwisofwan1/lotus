import { describe, it, expect, vi } from "vitest";
import { openInCode, subscribeOpenInCode } from "../open-in-code";

describe("asking the Code app to open a file", () => {
  it("hands the path and line to every subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeOpenInCode(a);
    const offB = subscribeOpenInCode(b);
    openInCode({ path: "/repo/src/a.ts", line: 12 });
    expect(a).toHaveBeenCalledWith({ path: "/repo/src/a.ts", line: 12 });
    expect(b).toHaveBeenCalledWith({ path: "/repo/src/a.ts", line: 12 });
    offA();
    offB();
  });

  it("stops delivering after unsubscribe, and is harmless with no subscriber", () => {
    const listener = vi.fn();
    const off = subscribeOpenInCode(listener);
    off();
    expect(() => openInCode({ path: "/repo/x.ts" })).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a request with no path", () => {
    const listener = vi.fn();
    const off = subscribeOpenInCode(listener);
    openInCode({ path: "" });
    expect(listener).not.toHaveBeenCalled();
    off();
  });
});
