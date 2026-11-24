import { describe, it, expect } from "vitest";
import { parseStreamJson } from "../stream-json.js";

const SUCCESS_OUTPUT = [
  '{"type":"system","subtype":"init","session_id":"sess-abc"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello!"}]}}',
  '{"type":"result","subtype":"success","session_id":"sess-abc","result":"Hello!","is_error":false}',
].join("\n");

const ERROR_OUTPUT = [
  '{"type":"system","subtype":"init","session_id":"sess-err"}',
  '{"type":"result","subtype":"error_during_execution","session_id":"sess-err","result":"Tool failed","is_error":true}',
].join("\n");

describe("parseStreamJson", () => {
  it("extracts text and sessionId from a success result", () => {
    const r = parseStreamJson(SUCCESS_OUTPUT);
    expect(r.text).toBe("Hello!");
    expect(r.sessionId).toBe("sess-abc");
    expect(r.isError).toBe(false);
  });

  it("extracts isError=true from an error result", () => {
    const r = parseStreamJson(ERROR_OUTPUT);
    expect(r.text).toBe("Tool failed");
    expect(r.sessionId).toBe("sess-err");
    expect(r.isError).toBe(true);
  });

  it("falls back to sessionId from init line when result line has none", () => {
    const output = [
      '{"type":"system","subtype":"init","session_id":"fallback-id"}',
      '{"type":"result","subtype":"success","session_id":"","result":"ok","is_error":false}',
    ].join("\n");
    const r = parseStreamJson(output);
    expect(r.sessionId).toBe("fallback-id");
  });

  it("returns isError=true when no result line is present", () => {
    const r = parseStreamJson("unexpected process output\nnot json");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("unexpected process output\nnot json");
  });

  it("skips blank lines and non-JSON lines without throwing", () => {
    const output = "\n\nnot-json\n" + SUCCESS_OUTPUT;
    expect(() => parseStreamJson(output)).not.toThrow();
    expect(parseStreamJson(output).text).toBe("Hello!");
  });

  it("uses the last result line when multiple are present", () => {
    const output = [
      '{"type":"result","subtype":"success","session_id":"s1","result":"first","is_error":false}',
      '{"type":"result","subtype":"success","session_id":"s2","result":"second","is_error":false}',
    ].join("\n");
    const r = parseStreamJson(output);
    expect(r.text).toBe("second");
    expect(r.sessionId).toBe("s2");
  });

  it("never returns undefined text when a result line omits the result field", () => {
    const output = [
      '{"type":"system","subtype":"init","session_id":"s3"}',
      '{"type":"result","subtype":"error_max_turns","session_id":"s3","is_error":true}',
    ].join("\n");
    const r = parseStreamJson(output);
    expect(() => r.text.trim()).not.toThrow();
    expect(r.isError).toBe(true);
  });

  it("surfaces the errors array when an error result omits the result field", () => {
    const output = [
      '{"type":"system","subtype":"init","session_id":"s4"}',
      '{"type":"result","subtype":"error_max_turns","session_id":"s4","is_error":true,"errors":["Reached maximum number of turns (1)"]}',
    ].join("\n");
    const r = parseStreamJson(output);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Reached maximum number of turns (1)");
    expect(r.text).not.toBe("");
  });

  it("falls back to api_error_status, then subtype, when an error result has no text", () => {
    const apiErr = [
      '{"type":"result","subtype":"error_during_execution","session_id":"s5","is_error":true,"api_error_status":"overage_rejected"}',
    ].join("\n");
    expect(parseStreamJson(apiErr).text).toContain("overage_rejected");

    const subtypeOnly = [
      '{"type":"result","subtype":"error_during_execution","session_id":"s6","is_error":true}',
    ].join("\n");
    expect(parseStreamJson(subtypeOnly).text).toContain("error_during_execution");
  });

  it("keeps text empty for a non-error result that omits the result field", () => {
    const output = [
      '{"type":"result","subtype":"success","session_id":"s7","is_error":false}',
    ].join("\n");
    const r = parseStreamJson(output);
    expect(r.text).toBe("");
    expect(r.isError).toBe(false);
  });
});
