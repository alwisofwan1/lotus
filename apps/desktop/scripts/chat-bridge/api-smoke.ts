// Smoke of the API runner (#288) through the real bridge, against a local stand-in for an
// OpenAI-compatible endpoint: streamed reasoning and text, usage, the history sent each turn,
// a rejected key, and an interrupt. Needs no network and spends nothing.
//
//   bun run scripts/chat-bridge/api-smoke.ts [--minimal-path]
// Against a real provider instead: LOTUS_API_SMOKE_URL, LOTUS_API_SMOKE_KEY, LOTUS_API_SMOKE_MODEL.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { isThreadEvent, startBridgeClient, type Json } from "./bridge-client";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const bodies: Json[] = [];
const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer sk-good") {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
    return;
  }
  let raw = "";
  for await (const part of request) raw += part;
  const body = JSON.parse(raw) as Json;
  bodies.push(body);
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (body.messages.at(-1).content === "slow") {
    // Never finishes on its own: only an interrupt ends this turn.
    response.write(sse([{ choices: [{ delta: { content: "Partly" } }] }]));
    setTimeout(() => response.end(), 5_000);
    return;
  }
  response.end(
    sse([
      { choices: [{ delta: { role: "assistant", reasoning_content: "Thinking it over." } }] },
      { choices: [{ delta: { content: `Answer ${bodies.length}` } }] },
      { choices: [], usage: { prompt_tokens: 12 * bodies.length, completion_tokens: 3 } },
    ]) + "data: [DONE]\n\n",
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const real = process.env.LOTUS_API_SMOKE_URL;
const baseUrl = real ?? `http://127.0.0.1:${port}/v1`;

const client = startBridgeClient({ minimalPath: process.argv.includes("--minimal-path") });
await client.request("initialize", {});

async function start(threadId: string, apiKey: string, history: Json[] = []) {
  const configured = client.waitFor((m) => isThreadEvent("session/configured")(m) && m.params.threadId === threadId, "session/configured");
  await client.request("thread/start", {
    threadId,
    runner: "api",
    cwd: "/",
    model: process.env.LOTUS_API_SMOKE_MODEL ?? "stand-in",
    api: { baseUrl, apiKey: real ? (process.env.LOTUS_API_SMOKE_KEY ?? null) : apiKey, providerName: "Stand-in" },
    history,
  });
  return configured;
}

async function turn(threadId: string, text: string, during?: () => Promise<void>) {
  const events: Json[] = [];
  const stop = client.listen((m) => m.method === "thread/event" && m.params.threadId === threadId && events.push(m.params.event));
  const done = client.waitFor((m) => isThreadEvent("turn/completed")(m) && m.params.threadId === threadId, "turn/completed");
  await client.request("turn/start", { threadId, text, clientRequestId: crypto.randomUUID() });
  await during?.();
  await done;
  stop();
  return events;
}

const configured = await start("a", "sk-good", [
  { role: "user", content: "Earlier question" },
  { role: "assistant", content: "Earlier answer" },
]);
check("configured with a key", configured.params.event.authSource === "apiKey");

const first = await turn("a", "Why 5 retries?");
const done = first.at(-1)!;
const texts = first.filter((e) => e.type === "item/completed").map((e) => `${e.item.kind}:${e.item.text}`);
check("turn completes", done.status === "completed", JSON.stringify(done.error));
if (!real) {
  check("reasoning then answer", texts.join(" | ") === "reasoning:Thinking it over. | agentMessage:Answer 1", texts.join(" | "));
  check("usage reported", done.usage?.inputTokens === 12 && done.usage?.outputTokens === 3, JSON.stringify(done.usage));
  check("seeded history sent", bodies[0].messages.length === 3 && bodies[0].messages[0].content === "Earlier question");
  check("stream asked with usage", bodies[0].stream === true && bodies[0].stream_options?.include_usage === true);

  await turn("a", "And jitter?");
  const roles = bodies[1].messages.map((m: Json) => `${m.role}:${m.content}`);
  check("second turn sends the whole thread", roles.join(" / ") === "user:Earlier question / assistant:Earlier answer / user:Why 5 retries? / assistant:Answer 1 / user:And jitter?", roles.join(" / "));

  const interrupted = await turn("a", "slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.request("turn/interrupt", { threadId: "a" });
  });
  check("interrupt ends the turn", interrupted.at(-1)!.status === "interrupted", interrupted.at(-1)!.status);

  await start("b", "sk-bad");
  const rejected = await turn("b", "hello");
  check("rejected key fails the turn with the reason", rejected.at(-1)!.status === "failed" && rejected.at(-1)!.error === "Stand-in answered 401: Authentication Fails", rejected.at(-1)!.error);
} else {
  console.log(texts.join("\n"));
}

client.close();
server.closeAllConnections();
server.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
