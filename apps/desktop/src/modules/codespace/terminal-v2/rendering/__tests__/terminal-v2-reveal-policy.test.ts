import { describe, expect, it } from "vitest";
import { resolveTerminalV2RevealPolicy } from "../terminal-v2-reveal-policy";

describe("resolveTerminalV2RevealPolicy", () => {
  it("hides inactive panes and cancels pending settle work", () => {
    expect(resolveTerminalV2RevealPolicy({
      active: false,
      hasTerminal: true,
      hasRenderedOnce: true,
      currentGeneration: 3,
    })).toEqual({
      generation: 4,
      revealState: "hidden",
      cancelSettle: true,
      scheduleFallback: false,
    });
  });

  it("warms active panes while the terminal handle is not ready", () => {
    expect(resolveTerminalV2RevealPolicy({
      active: true,
      hasTerminal: false,
      hasRenderedOnce: false,
      currentGeneration: 0,
    })).toEqual({
      generation: 1,
      revealState: "warming",
      cancelSettle: false,
      scheduleFallback: false,
    });
  });

  it("settles immediately after the terminal has rendered once", () => {
    expect(resolveTerminalV2RevealPolicy({
      active: true,
      hasTerminal: true,
      hasRenderedOnce: true,
      currentGeneration: 1,
    })).toEqual({
      generation: 2,
      revealState: "settled",
      cancelSettle: true,
      scheduleFallback: false,
    });
  });

  it("uses warming plus fallback for first visible terminal render", () => {
    expect(resolveTerminalV2RevealPolicy({
      active: true,
      hasTerminal: true,
      hasRenderedOnce: false,
      currentGeneration: 1,
    })).toEqual({
      generation: 2,
      revealState: "warming",
      cancelSettle: false,
      scheduleFallback: true,
    });
  });
});
