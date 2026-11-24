import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_V2_OUTPUT_OVERFLOW_NOTICE,
  TerminalV2OutputRing,
} from "../terminal-v2-output-ring";

describe("TerminalV2OutputRing", () => {
  it("emits one overflow notice and resumes at a line boundary", () => {
    const ring = new TerminalV2OutputRing({ blockSize: 6, maxBlocks: 2 });
    const write = vi.fn();

    ring.append("drop0\nkeep1\nkeep2\ntail");
    ring.drain(write);

    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
      TERMINAL_V2_OUTPUT_OVERFLOW_NOTICE,
      "keep2\n",
      "tail",
    ]);
    expect(ring.getDropCount()).toBe(1);

    write.mockClear();
    ring.append("fresh\n");
    ring.drain(write);
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(["fresh\n"]);
  });

  it("clears retained output and overflow state", () => {
    const ring = new TerminalV2OutputRing({ blockSize: 4, maxBlocks: 1 });
    const write = vi.fn();

    ring.append("abcdline\n");
    expect(ring.getDropCount()).toBeGreaterThan(0);

    ring.clear();
    ring.drain(write);

    expect(write).not.toHaveBeenCalled();
    expect(ring.hasData()).toBe(false);
    expect(ring.getDropCount()).toBe(0);
  });

  it("drains appended output in order", () => {
    const ring = new TerminalV2OutputRing({ blockSize: 4, maxBlocks: 4 });
    const write = vi.fn();

    ring.append("ab");
    ring.append("cdef");
    ring.append("g");

    expect(ring.hasData()).toBe(true);
    ring.drain(write);

    expect(write.mock.calls.map(([chunk]) => chunk).join("")).toBe("abcdefg");
    expect(ring.hasData()).toBe(false);
  });
});
