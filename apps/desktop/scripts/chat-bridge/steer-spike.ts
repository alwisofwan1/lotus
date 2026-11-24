// Spike 0b (#272): does a steer sent during a tool-using turn reach the model at the next tool
// boundary, or does it wait for the turn to end (as it does on a text-only turn, PLAN finding 1)?
//
//   bun run scripts/chat-bridge/steer-spike.ts
//
// One turn runs five slow Bash steps. After the first tool result, a steer asks to stop. If the
// steer injects, the first `result` already says STEERED and fewer than five steps ran.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSdkEvent as isEvent, startBridgeClient, type Json } from "./bridge-client";

const STEPS = 5;
const client = startBridgeClient({ minimalPath: false, raw: true });
const { request, waitFor } = client;

const t0 = Date.now();
const log: string[] = [];
const note = (line: string) => log.push(`+${String(Date.now() - t0).padStart(6)}ms  ${line}`);

const isToolResult = (m: Json) =>
  isEvent("user")(m) && Array.isArray(m.params.event.message?.content) && m.params.event.message.content.some((c: Json) => c.type === "tool_result");

async function main(): Promise<void> {
  await request("initialize", {});
  const cwd = mkdtempSync(join(tmpdir(), "lotus-steer-spike-"));
  const threadId = "steer-spike";
  // Only the harmless step commands are allowed.
  client.setApprovalPolicy((req) =>
    req.toolName === "Bash" && /^sleep \d+ && echo step\d$/.test(String(req.input?.command ?? "").trim())
      ? { behavior: "allow" }
      : { behavior: "deny", message: "only the step commands are allowed in this spike" },
  );
  await request("thread/start", { threadId, cwd, model: "haiku", permissionMode: "default" });

  const commands: string[] = [];
  const results: Json[] = [];
  let steerSentAt = 0;
  client.listen((m) => {
    if (m.method !== "thread/raw") return;
    const event = m.params.event;
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          commands.push(String(block.input?.command ?? block.name));
          note(`tool_use ${block.input?.command ?? block.name}${steerSentAt ? " (after steer)" : ""}`);
        }
        if (block.type === "text" && block.text.trim()) note(`text ${JSON.stringify(block.text.slice(0, 80))}`);
      }
    } else if (event.type === "user") {
      const content = event.message?.content;
      const text = typeof content === "string" ? content : (content ?? []).map((c: Json) => c.type === "text" ? c.text : `[${c.type}]`).join(" ");
      note(`user${event.isReplay ? " REPLAY" : ""}${event.priority ? ` priority=${event.priority}` : ""} ${JSON.stringify(String(text).slice(0, 100))}`);
    } else if (event.type === "result") {
      results.push(event);
      note(`result ${JSON.stringify(String(event.result ?? "").slice(0, 80))} subtype=${event.subtype}`);
    } else if (event.type === "system") {
      note(`system ${event.subtype}`);
    }
  });

  const steps = Array.from({ length: STEPS }, (_, i) => `sleep 3 && echo step${i + 1}`);
  await request("turn/start", {
    threadId,
    clientRequestId: "base",
    text: `Use the Bash tool to run these ${STEPS} commands, exactly as written, one tool call each, in order, never in parallel:\n${steps.join("\n")}\nAfter all of them, reply only DONE.`,
  });
  await waitFor(isToolResult, "first tool result");
  steerSentAt = Date.now();
  note("steer sent");
  const steer = await request("turn/steer", { threadId, clientRequestId: "steer", text: "Stop. Run no more commands. Reply only with the word STEERED." });
  note(`steer accepted after ${steer.acceptedAfterMs}ms`);

  await waitFor((m) => isEvent("result")(m) && /STEERED/.test(m.params.event.result ?? ""), "STEERED result");
  // A queued steer runs as a second turn; give a stray extra result a moment to arrive.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const stepsRun = commands.filter((c) => /echo step\d/.test(c)).length;
  const injected = results.length === 1 || /STEERED/.test(results[0]?.result ?? "");
  console.log(log.join("\n"));
  console.log(`\nsteps run: ${stepsRun}/${STEPS}  results: ${results.length}  first result: ${JSON.stringify(results[0]?.result)}`);
  console.log(`verdict: ${injected ? "INJECT — the steer reached the running turn" : "QUEUE — the steer ran as the next turn"}`);

  // The translator gives each turn/started the oldest noted input. An injected steer opens no
  // turn, so check which input the next turn is labelled with.
  const nextStarted = waitFor((m) => m.method === "thread/event" && m.params.event.type === "turn/started", "next turn/started");
  await request("turn/start", { threadId, clientRequestId: "after", text: "Reply only with the word ALIVE." });
  const label = (await nextStarted).params.event.input?.clientRequestId;
  console.log(`next turn labelled with input: ${label} ${label === "after" ? "(correct)" : "(WRONG — expected after)"}`);
  await request("thread/stop", { threadId });
}

main()
  .catch((error: Error) => {
    console.log(log.join("\n"));
    console.error(`spike failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => client.close());
