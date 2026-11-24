import { describe, expect, it, vi } from "vitest";
import {
  appendDraft,
  onThreadDraft,
  requestThreadDraft,
  takeThreadDraft,
} from "@/modules/codespace/state/thread-draft-inbox";

describe("thread draft inbox", () => {
  it("keeps a draft until the composer takes it, once", () => {
    requestThreadDraft("s-1", "src/x.ts:1");
    expect(takeThreadDraft("s-1")).toBe("src/x.ts:1");
    expect(takeThreadDraft("s-1")).toBeNull();
  });

  it("joins drafts that arrive before the composer mounts", () => {
    requestThreadDraft("s-2", "first");
    requestThreadDraft("s-2", "second");
    expect(takeThreadDraft("s-2")).toBe("first\n\nsecond");
  });

  it("tells a listening composer, and only that session's", () => {
    const mine = vi.fn();
    const other = vi.fn();
    const stop = onThreadDraft("s-3", mine);
    onThreadDraft("s-4", other);
    requestThreadDraft("s-3", "x");
    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    stop();
    requestThreadDraft("s-3", "y");
    expect(mine).toHaveBeenCalledTimes(1);
    takeThreadDraft("s-3");
  });

  it("appends after what is typed, with a blank line between", () => {
    expect(appendDraft("", "code")).toBe("code");
    expect(appendDraft("look at this  \n", "code")).toBe("look at this\n\ncode");
  });
});
