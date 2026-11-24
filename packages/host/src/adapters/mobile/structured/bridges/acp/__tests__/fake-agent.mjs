// A minimal ACP agent, so the session can be tested without a subscription or a network.
//
// It answers the same handshake `cursor-agent acp` answered on 2026-09-06, then replays a
// scripted turn. `FAKE_ACP` selects the script:
//   ok          — a text turn ending `end_turn`
//   permission  — asks `session/request_permission` and waits for the answer before finishing
//   unauthed    — fails `authenticate`, the way an agent that was never signed in does
import { createInterface } from "node:readline";

const script = process.env.FAKE_ACP ?? "ok";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

let sessionId = "sess-fake";
let permissionAnswer;

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (line.trim() === "") return;
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    // A response to our own server request.
    if (permissionAnswer) permissionAnswer(msg.result);
    return;
  }
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
      });
    case "authenticate":
      return script === "unauthed"
        ? send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "not logged in" } })
        : reply(msg.id, {});
    case "session/new":
      return reply(msg.id, { sessionId, modes: { currentModeId: "agent" } });
    case "session/set_mode":
      update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: msg.params.modeId });
      return reply(msg.id, {});
    case "session/set_model":
      return reply(msg.id, {});
    case "session/cancel":
      return reply(msg.id, {});
    case "session/prompt": {
      update(sessionId, { sessionUpdate: "session_info_update", title: "Fake Turn" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "he" } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "llo" } });
      if (script === "permission") {
        const answer = await new Promise((resolve) => {
          permissionAnswer = resolve;
          send({
            jsonrpc: "2.0",
            id: 9001,
            method: "session/request_permission",
            params: {
              toolCall: { toolCallId: "call-1\nfc_1", title: "Run `rm -rf /`" },
              options: [
                { optionId: "reject", name: "No", kind: "reject_once" },
                { optionId: "allow", name: "Yes", kind: "allow_once" },
              ],
            },
          });
        });
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call-1\nfc_1",
          title: "`rm -rf /`",
          kind: "execute",
          status: answer?.outcome?.optionId === "allow" ? "completed" : "failed",
        });
      }
      return reply(msg.id, { stopReason: "end_turn" });
    }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
  }
});
