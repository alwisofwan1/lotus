// Diagnostic (#273): how long after the model's last output does the turn's `result` arrive?
// The bridge loads the user's settings (settingSources "user"), so the user's Stop hooks run
// between the answer and `result`; a slow hook would keep a chat turn "running".
//
//   bun run scripts/chat-bridge/result-latency.ts
//
// Prints, per turn, the gap between the last `message_stop` and `result`, and the hook events
// seen in that gap.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSdkEvent as isEvent, startBridgeClient, type Json } from "./bridge-client";

const PROMPTS = [
  "Reply with exactly the word PONG and nothing else.",
  "In about 150 words, explain what a lotus flower symbolises.",
  "Use the Bash tool to run `echo hi`, then reply with its output only.",
];

const client = startBridgeClient({ minimalPath: false, raw: true });
client.setApprovalPolicy((req) =>
  req.toolName === "Bash" && String(req.input?.command ?? "").trim() === "echo hi"
    ? { behavior: "allow" }
    : { behavior: "deny", message: "not allowed in this diagnostic" },
);

async function main(): Promise<void> {
  await client.request("initialize", {});
  const threadId = "result-latency";
  const cwd = mkdtempSync(join(tmpdir(), "lotus-result-latency-"));
  await client.request("thread/start", { threadId, cwd, model: "haiku", permissionMode: "default" });

  let lastStop = 0;
  let hooks: string[] = [];
  client.listen((m) => {
    if (m.method !== "thread/raw") return;
    const e = m.params.event as Json;
    if (e.type === "stream_event" && e.event?.type === "message_stop") {
      lastStop = Date.now();
      hooks = [];
    }
    if (e.type === "system" && String(e.subtype).startsWith("hook_")) hooks.push(`${e.subtype}:${e.hook_event ?? e.hook_name ?? "?"}`);
  });

  for (const text of PROMPTS) {
    const sentAt = Date.now();
    const done = client.waitFor(isEvent("result"), "result");
    await client.request("turn/start", { threadId, text, clientRequestId: crypto.randomUUID() });
    const result = (await done).params.event;
    const now = Date.now();
    console.log(
      `turn ${JSON.stringify(text.slice(0, 40))}: total=${now - sentAt}ms lastOutput→result=${lastStop ? now - lastStop : "n/a"}ms ` +
        `hooks=[${hooks.join(", ")}] subtype=${result.subtype}`,
    );
  }
  await client.request("thread/stop", { threadId });
}

main()
  .catch((error: Error) => {
    console.error(`diagnostic failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => client.close());
