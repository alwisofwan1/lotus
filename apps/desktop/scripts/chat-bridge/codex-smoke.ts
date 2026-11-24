// Live smoke of the Codex runner (#286) through the real bridge and `codex app-server`, with the
// user's own `codex login`. Needs network; spends a few small turns.
//
//   bun run scripts/chat-bridge/codex-smoke.ts [--minimal-path]

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isThreadEvent, startBridgeClient, type Json } from "./bridge-client";

const minimalPath = process.argv.includes("--minimal-path");
const cwd = mkdtempSync(join(tmpdir(), "lotus-codex-smoke-"));
writeFileSync(join(cwd, "a.txt"), "a\n");
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function turn(client: ReturnType<typeof startBridgeClient>, threadId: string, text: string) {
  const events: Json[] = [];
  const stop = client.listen((m) => m.method === "thread/event" && m.params.threadId === threadId && events.push(m.params.event));
  const done = client.waitFor((m) => isThreadEvent("turn/completed")(m) && m.params.threadId === threadId, "turn/completed");
  await client.request("turn/start", { threadId, text, clientRequestId: crypto.randomUUID() });
  await done;
  stop();
  return events;
}

const first = startBridgeClient({ minimalPath });
first.setApprovalPolicy(() => ({ behavior: "allow" }));
const init = await first.request("initialize", {});
check("codex found", typeof init.codexPath === "string", init.codexPath);

const { models } = await first.request("models/list", { runner: "codex" });
check("models listed with efforts", models.length > 0 && models[0].efforts.length > 0, models.map((m: Json) => m.value).join(", "));

const threadId = "smoke-codex";
const configured = first.waitFor((m) => isThreadEvent("session/configured")(m), "session/configured");
await first.request("thread/start", { threadId, runner: "codex", cwd, permissionMode: "default", effort: "low" });
const session = (await configured).params.event;
check("session configured", !!session.providerSessionId, `${session.model}, ${session.authSource}`);

const one = await turn(first, threadId, "Run `ls` in this folder, then reply with exactly the word PINEAPPLE.");
const command = one.find((e) => e.type === "item/completed" && e.item.kind === "command");
check("approval asked for the command", first.approvalsSeen.some((a) => a.toolName === "Bash"), JSON.stringify(first.approvalsSeen[0]?.input));
check("command ran with output", command?.item.status === "completed" && /a\.txt/.test(command.item.output ?? ""), command?.item.command);
const started = one.find((e) => e.type === "turn/started");
check("turn labelled with its input", /PINEAPPLE/.test(started?.input?.text ?? ""));
const answer = one.filter((e) => e.type === "item/completed" && e.item.kind === "agentMessage").at(-1);
check("answer", /PINEAPPLE/.test(answer?.item.text ?? ""), answer?.item.text);

// Steer a running turn: the message lands inside it.
const steerEvents: Json[] = [];
const stopSteer = first.listen((m) => m.method === "thread/event" && steerEvents.push(m.params.event));
const steered = first.waitFor((m) => isThreadEvent("turn/completed")(m), "steered turn");
const steerDelta = first.waitFor((m) => isThreadEvent("item/delta")(m), "steer delta");
await first.request("turn/start", { threadId, text: "Count slowly from 1 to 200, one number per line.", clientRequestId: crypto.randomUUID() });
await steerDelta;
await first.request("turn/steer", { threadId, text: "Stop counting. Reply with only the word STEERED.", clientRequestId: crypto.randomUUID() });
await steered;
stopSteer();
const steerItem = steerEvents.find((e) => e.type === "item/completed" && e.item.kind === "userMessage");
const steerAnswer = steerEvents.find((e) => e.type === "item/completed" && e.item.kind === "agentMessage" && /STEERED/.test(e.item.text));
check("steer lands in the running turn", !!steerItem && steerEvents.filter((e) => e.type === "turn/started").length === 1, steerItem?.item.text);
check("steer is followed", /STEERED/.test(steerAnswer?.item.text ?? ""), steerAnswer?.item.text?.slice(-60));

// Interrupt a long answer.
const interrupted = first.waitFor((m) => isThreadEvent("turn/completed")(m), "interrupted turn");
const firstDelta = first.waitFor((m) => isThreadEvent("item/delta")(m), "first delta");
await first.request("turn/start", { threadId, text: "Write a 400-word story about a lighthouse.", clientRequestId: crypto.randomUUID() });
await firstDelta;
await first.request("turn/interrupt", { threadId });
const status = (await interrupted).params.event.status;
check("interrupt ends the turn", status === "interrupted", status);

await first.request("thread/stop", { threadId });
first.close();

// A new bridge resumes the same Codex thread.
const second = startBridgeClient({ minimalPath });
second.setApprovalPolicy(() => ({ behavior: "allow" }));
await second.request("initialize", {});
await second.request("thread/start", { threadId, runner: "codex", cwd, permissionMode: "default", resumeSessionId: session.providerSessionId });
const resumed = await turn(second, threadId, "In my very first message I asked you to reply with one exact word. Which word? Reply with only that word.");
const recalled = resumed.filter((e) => e.type === "item/completed" && e.item.kind === "agentMessage").at(-1);
check("resume keeps the conversation", /PINEAPPLE/.test(recalled?.item.text ?? ""), recalled?.item.text);
second.close();

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
