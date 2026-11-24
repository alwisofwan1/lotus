import { describe, it, expect } from "vitest";

import { createLogger } from "../logger.js";

function makeSinkCapture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe("logger", () => {
  it("info() writes one JSON line per call", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink });

    logger.info("bot.start");

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event).toBe("bot.start");
    expect(parsed.level).toBe("info");
    expect(typeof parsed.ts).toBe("number");
  });

  it("info() includes custom fields", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink });

    logger.info("command.invoked", { deviceId: "42", command: "/fleet" });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.deviceId).toBe("42");
    expect(parsed.command).toBe("/fleet");
  });

  it("warn() emits with level 'warn'", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink });

    logger.warn("api.slow", { latencyMs: 5000 });

    expect(JSON.parse(lines[0]!).level).toBe("warn");
  });

  it("error() emits with level 'error'", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink });

    logger.error("api.failed", { reason: "timeout" });

    expect(JSON.parse(lines[0]!).level).toBe("error");
  });

  it("audit() emits with category 'audit'", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink });

    logger.audit("auth.allowed", { deviceId: "42" });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.category).toBe("audit");
    expect(parsed.event).toBe("auth.allowed");
    expect(parsed.deviceId).toBe("42");
  });

  it("info/warn/error default to category 'log'", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink });

    logger.info("foo");
    logger.warn("bar");
    logger.error("baz");

    expect(lines.map((l) => JSON.parse(l).category)).toEqual(["log", "log", "log"]);
  });

  it("audit() of 'bridge.chat.full_content' is suppressed when verbose=false", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink, verbose: false });

    logger.audit("bridge.chat.full_content", { content: "secret" });

    expect(lines).toHaveLength(0);
  });

  it("audit() of 'bridge.chat.full_content' is emitted when verbose=true", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink, verbose: true });

    logger.audit("bridge.chat.full_content", { content: "secret" });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe("bridge.chat.full_content");
  });

  it("audit() of non-verbose events emits regardless of verbose flag", () => {
    const { lines, sink } = makeSinkCapture();
    const logger = createLogger({ sink, verbose: false });

    logger.audit("dispatch.executed", { paneId: "p1" });

    expect(lines).toHaveLength(1);
  });
});
