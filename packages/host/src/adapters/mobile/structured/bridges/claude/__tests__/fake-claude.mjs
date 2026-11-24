// A minimal `claude --print --output-format stream-json`, so the session can be tested
// without a subscription. `FAKE_CLAUDE` picks the script: `ok`, `tools`, `silent`,
// `interruptible` (holds the turn until a control `interrupt`), `deaf` (an old CLI: no controls).
import { createInterface } from "node:readline";

const script = process.env.FAKE_CLAUDE ?? "ok";
const sessionId = "11111111-2222-3333-4444-555555555555";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let turns = 0;

send({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const msg = JSON.parse(line);
  // The control channel shares this stdin with prompts, as the real CLI's does.
  if (msg.type === "control_request") {
    if (script === "deaf") return;
    if (msg.request?.subtype === "interrupt") {
      // What the real CLI answered on 2026-11-24: the ack, then the turn ends as an error.
      send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
      return send({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, num_turns: turns, permission_denials: [] });
    }
    return send({
      type: "control_response",
      response: { subtype: "success", request_id: msg.request_id, response: { mode: msg.request?.mode } },
    });
  }
  const asked = msg.message.content[0].text;
  turns += 1;
  if (script === "silent" || script === "deaf") return; // never answers: the turn stays open
  if (script === "interruptible" && turns === 1) return; // the first turn waits for a Stop
  if (script === "env") {
    // Reports the profile it was started under, so a test can assert the child's own env.
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `dir=${process.env.CLAUDE_CONFIG_DIR ?? "none"}` }] } });
    return send({
      type: "result", subtype: "success", stop_reason: "end_turn", is_error: false,
      session_id: sessionId, num_turns: turns, permission_denials: [],
    });
  }
  if (script === "tools") {
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/w/a.ts" } }] },
    });
    send({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "alpha", is_error: false }] },
    });
  }
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `hello ${asked}` }] } });
  send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1788763800 } });
  send({
    type: "result", subtype: "success", stop_reason: "end_turn", is_error: false,
    session_id: sessionId, num_turns: turns, total_cost_usd: 0.01,
    usage: { input_tokens: 5, output_tokens: 7 }, permission_denials: [],
  });
});
