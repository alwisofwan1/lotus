// Live smoke test for the chat bridge. Drives a real Claude session with the user's own login:
// one turn, one tool approval, one question, a steer, an interrupt, then stop. Uses a cheap model.
//
//   bun run scripts/chat-bridge/smoke.ts                 # inherit PATH
//   bun run scripts/chat-bridge/smoke.ts --minimal-path  # PATH like a GUI app launched from Finder

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSdkEvent as isEvent, isTextDelta, isThreadEvent, startBridgeClient, type Json } from "./bridge-client";

const minimalPath = process.argv.includes("--minimal-path");
const client = startBridgeClient({ minimalPath, raw: true });
const { request, waitFor, approvalsSeen } = client;

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function record(check: string, pass: boolean, detail: string): void {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check} — ${detail}`);
}

async function turn(threadId: string, text: string): Promise<{ result: Json; acceptedAfterMs: number }> {
  const done = waitFor(isEvent("result"), `result of "${text.slice(0, 30)}"`);
  const accepted = await request("turn/start", { threadId, text, clientRequestId: crypto.randomUUID() });
  return { result: (await done).params.event, acceptedAfterMs: accepted.acceptedAfterMs };
}

async function main(): Promise<void> {
  const hello = await request("initialize", {});
  record("resolve claude", typeof hello.claudePath === "string", `${hello.claudePath} (PATH ${minimalPath ? "minimal" : "inherited"})`);
  if (!hello.claudePath) return;

  const cwd = mkdtempSync(join(tmpdir(), "lotus-chat-bridge-"));
  const threadId = "smoke-1";
  await request("thread/start", { threadId, cwd, model: "haiku", permissionMode: "default" });

  const init = waitFor((m) => isEvent("system")(m) && m.params.event.subtype === "init", "system init");
  const configured = waitFor(isThreadEvent("session/configured"), "session/configured");
  const t0 = Date.now();
  const firstDelta = waitFor(isTextDelta, "first text delta");
  const first = await turn(threadId, "Reply with exactly the word PONG and nothing else.");
  const deltaAt = (await firstDelta) && Date.now() - t0;
  record("turn", /PONG/.test(first.result.result ?? ""), `result=${JSON.stringify(first.result.result)} subtype=${first.result.subtype} accepted=${first.acceptedAfterMs}ms streamed<=${deltaAt}ms`);

  const initEvent = (await init).params.event;
  const authSource = (await configured).params.event.authSource;
  record("auth", typeof initEvent.apiKeySource === "string" && authSource !== "unknown", `apiKeySource=${initEvent.apiKeySource} authSource=${authSource} model=${initEvent.model}`);

  client.setApprovalPolicy((req) => (req.toolName === "Write" ? { behavior: "allow" } : { behavior: "deny", message: "only Write is allowed in this test" }));
  const approval = await turn(threadId, "Use the Write tool to create hello.txt in the current directory containing exactly: lotus");
  const file = join(cwd, "hello.txt");
  const written = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  record("approval", approvalsSeen.some((r) => r.toolName === "Write") && written === "lotus", `requests=${approvalsSeen.map((r) => r.toolName).join(",")} file=${JSON.stringify(written)} subtype=${approval.result.subtype}`);

  // AskUserQuestion is answered through allow + answers (PLAN finding 11).
  client.setApprovalPolicy((req) => {
    const questions = (req.input.questions ?? []) as Array<{ question: string }>;
    return req.toolName === "AskUserQuestion"
      ? { behavior: "allow", answers: Object.fromEntries(questions.map((q) => [q.question, "Blue"])) }
      : { behavior: "deny", message: "only AskUserQuestion is allowed in this test" };
  });
  const asked = waitFor((m) => isThreadEvent("interaction/requested")(m) && m.params.event.interaction.kind === "question", "question requested");
  const answered = waitFor((m) => isThreadEvent("interaction/resolved")(m) && m.params.event.decision === "answered", "question answered");
  const question = await turn(
    threadId,
    "Use the AskUserQuestion tool to ask me which colour I prefer, with exactly two options, Red and Blue. After I answer, reply with only the colour I chose, in uppercase.",
  );
  const answers = (await answered).params.event.answers;
  record("question", (await asked) && /BLUE/.test(question.result.result ?? ""), `answers=${JSON.stringify(answers)} result=${JSON.stringify(question.result.result)}`);

  const steerResults: Json[] = [];
  const collectResults = (m: Json) => {
    if (isEvent("result")(m)) steerResults.push(m.params.event);
  };
  const stopCollecting = client.listen(collectResults);
  const longTurn = request("turn/start", { threadId, text: "Count from 1 to 60, one number per line, nothing else.", clientRequestId: "steer-base" });
  await longTurn;
  await waitFor(isTextDelta, "counting to start");
  const steerSentAt = Date.now();
  const steer = await request("turn/steer", { threadId, text: "Stop counting now. Reply only with the word STEERED.", clientRequestId: "steer-1" });
  const steered = await waitFor((m) => isEvent("result")(m) && /STEERED/.test(m.params.event.result ?? ""), "steered result").catch(() => null);
  stopCollecting();
  const countResult = steerResults.find((r) => !/STEERED/.test(r.result ?? ""));
  const countLines = (countResult?.result ?? "").trim().split("\n");
  record("steer", steered !== null, `accepted=${steer.acceptedAfterMs}ms answeredAfter=${Date.now() - steerSentAt}ms results=${steerResults.length} countTurn={lines:${countLines.length}, last:${JSON.stringify(countLines.at(-1))}, subtype:${countResult?.subtype}} steered=${JSON.stringify(steered?.params.event.result)}`);

  const essayDone = waitFor(isEvent("result"), "interrupted result");
  // Match the essay's own turn: the previous turn's completion can still be in flight here.
  const essayTurn = waitFor(
    (m) => isThreadEvent("turn/started")(m) && m.params.event.input?.clientRequestId === "essay",
    "essay turn/started",
  ).then((started) =>
    waitFor((m) => isThreadEvent("turn/completed")(m) && m.params.event.turnId === started.params.event.turnId, "essay turn/completed"),
  );
  await request("turn/start", { threadId, text: "Write a 700-word essay about lotus flowers.", clientRequestId: "essay" });
  await waitFor(isTextDelta, "essay to start");
  const interruptAt = Date.now();
  await request("turn/interrupt", { threadId });
  const interrupted = await essayDone;
  const essay = interrupted.params.event;
  const essayWords = String(essay.result ?? "").split(/\s+/).filter(Boolean).length;
  const turnStatus = (await essayTurn).params.event.status;
  record("interrupt", essayWords < 600 && turnStatus === "interrupted", `stoppedAfter=${Date.now() - interruptAt}ms subtype=${essay.subtype} is_error=${essay.is_error} words=${essayWords} turn=${turnStatus} keys=${Object.keys(essay).join(",")}`);

  const alive = await turn(threadId, "Reply with exactly the word ALIVE and nothing else.");
  record("session survives interrupt", /ALIVE/.test(alive.result.result ?? ""), `result=${JSON.stringify(alive.result.result)}`);

  const ended = waitFor((m) => m.method === "thread/ended", "thread/ended");
  await request("thread/stop", { threadId });
  const end = await ended;
  record("stop", typeof end.params.providerSessionId === "string", `providerSessionId=${end.params.providerSessionId} error=${end.params.error}`);
}

main()
  .catch((error: Error) => record("smoke", false, error.message))
  .finally(() => {
    client.close();
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed === 0 ? 0 : 1);
  });
