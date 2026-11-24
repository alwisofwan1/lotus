// A stand-in ACP agent: answers the handshake; session ids carry its pid, so a test sees which process served.
import { createInterface } from "node:readline";
let n = 0;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const configOptions = [{ id: "model", currentValue: "m1", options: [{ value: "m1", name: "Model 1" }] }, { id: "mode", currentValue: "default" }];
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "session/new") {
    const sessionId = `${process.pid}-${++n}`;
    reply(id, { sessionId, configOptions });
    // As agy: the commands come after the reply, and a project's skills depend on the cwd.
    const availableCommands = [{ name: "compact", description: "Compact" }, { name: `skill-in-${params.cwd}`, description: "A skill" }];
    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands } } }) + "\n"), 20);
  }
  else if (method === "session/prompt") {
    // Echoes the first block it was given, so a test sees what the agent received.
    const text = params.prompt?.[0]?.text ?? "";
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }) + "\n");
    reply(id, { stopReason: "end_turn" });
  }
  else reply(id, {});
});
