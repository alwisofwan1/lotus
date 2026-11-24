import { describe, it, expect } from "vitest";
import { parseCodexJsonl } from "../codex-stream.js";

const OK_RUN = [
  '{"type":"thread.started","thread_id":"019ec741-5d48-7f51-92af-afd24c4c150b"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"output_tokens":6}}',
].join("\n");

describe("parseCodexJsonl", () => {
  it("extracts the thread id as the session id and the agent message as text", () => {
    const r = parseCodexJsonl(OK_RUN);
    expect(r.sessionId).toBe("019ec741-5d48-7f51-92af-afd24c4c150b");
    expect(r.text).toBe("PONG");
    expect(r.isError).toBe(false);
  });

  it("concatenates multiple agent_message items in order", () => {
    const raw = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"part one"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"part two"}}',
    ].join("\n");
    expect(parseCodexJsonl(raw).text).toBe("part one\npart two");
  });

  it("ignores non-message items and non-JSON lines", () => {
    const raw = [
      "Shell cwd was reset to /somewhere", // codex prints stray non-JSON lines
      '{"type":"thread.started","thread_id":"t2"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking..."}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}',
    ].join("\n");
    const r = parseCodexJsonl(raw);
    expect(r.text).toBe("answer");
    expect(r.sessionId).toBe("t2");
  });

  it("flags an error event and surfaces its plain-string message as text", () => {
    const raw = [
      '{"type":"thread.started","thread_id":"t3"}',
      '{"type":"error","message":"model overloaded"}',
    ].join("\n");
    const r = parseCodexJsonl(raw);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("model overloaded");
  });

  it("unwraps a nested API error message and dedupes error+turn.failed", () => {
    const nested = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5-codex\' model is not supported when using Codex with a ChatGPT account."}}';
    const raw = [
      '{"type":"thread.started","thread_id":"t4"}',
      `{"type":"error","message":${JSON.stringify(nested)}}`,
      `{"type":"turn.failed","error":{"message":${JSON.stringify(nested)}}}`,
    ].join("\n");
    const r = parseCodexJsonl(raw);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.");
  });

  it("keeps assistant text even when a late error event arrives", () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"partial answer"}}',
      '{"type":"error","message":"late failure"}',
    ].join("\n");
    const r = parseCodexJsonl(raw);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("partial answer");
  });

  it("returns null session and empty text for empty output", () => {
    expect(parseCodexJsonl("")).toEqual({ sessionId: null, text: "", isError: false });
  });
});
