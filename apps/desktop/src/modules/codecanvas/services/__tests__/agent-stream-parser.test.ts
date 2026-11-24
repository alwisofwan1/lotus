import { describe, it, expect } from "vitest";
import { parseAgentStreamLine } from "../agent-stream-parser";

describe("parseAgentStreamLine", () => {
  it("maps an assistant text block to a text event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Analyzing component tree" }] },
    });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "text", text: "Analyzing component tree" });
  });

  it("labels a Read tool_use with the file path", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } }] },
    });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "tool", label: "Reading src/auth.ts" });
  });

  it("labels a Bash tool_use with the command", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
    });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "tool", label: "Running: npm test" });
  });

  it("falls back to a generic label for unknown tools", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } }] },
    });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "tool", label: "Using Glob" });
  });

  it("extracts the session id from a system init line", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-123" });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "session", sessionId: "sess-123" });
  });

  it("maps a successful claude result to an ok result event", () => {
    const line = JSON.stringify({ type: "result", is_error: false, result: "done" });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "result", ok: true, text: "done" });
  });

  it("maps a failed claude result to a not-ok result event", () => {
    const line = JSON.stringify({ type: "result", is_error: true });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "result", ok: false, text: undefined });
  });

  it("captures token usage and cost from the result event", () => {
    const line = JSON.stringify({
      type: "result", is_error: false, result: "done",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
    });
    expect(parseAgentStreamLine(line)).toEqual({
      kind: "result", ok: true, text: "done",
      usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.0123 },
    });
  });

  it("omits usage when the result carries no usage block", () => {
    const line = JSON.stringify({ type: "result", is_error: false, result: "done" });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "result", ok: true, text: "done" });
  });

  it("maps the run_codechat _final wrapper to an exit event", () => {
    const line = JSON.stringify({ type: "_final", runId: "r1", status: "completed", exitCode: 0 });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "exit", code: 0 });
  });

  it("maps the run_codechat _error wrapper to a not-ok result event", () => {
    const line = JSON.stringify({ type: "_error", text: "spawn failed" });
    expect(parseAgentStreamLine(line)).toEqual({ kind: "result", ok: false, text: "spawn failed" });
  });

  it("skips perf, user, and malformed lines", () => {
    expect(parseAgentStreamLine(JSON.stringify({ type: "_perf", stage: "spawn" }))).toBeNull();
    expect(parseAgentStreamLine(JSON.stringify({ type: "user" }))).toBeNull();
    expect(parseAgentStreamLine("not json")).toBeNull();
    expect(parseAgentStreamLine("")).toBeNull();
  });
});
