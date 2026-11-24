// Records real Claude conversations through the bridge as JSONL fixtures for the chat domain
// tests. Each scenario runs in a fresh thread and temp directory. Uses the user's own login.
//
//   bun run scripts/chat-bridge/record-fixtures.ts [scenario ...]
//
// Output: src/modules/chat/providers/claude/__fixtures__/<scenario>.jsonl. Raw SDK messages
// (`thread/raw`), so the translator can be re-tested against them. The home directory and
// the temp directory are replaced with placeholders, and the per-machine lists in the system
// init message (tools, MCP servers, skills, plugins, …) are emptied.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isSdkEvent, isTextDelta, startBridgeClient, type Json } from "./bridge-client";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src/modules/chat/providers/claude/__fixtures__");
const INIT_LISTS = ["tools", "mcp_servers", "slash_commands", "skills", "plugins", "agents", "output_styles"];

interface Scenario {
  name: string;
  seed?: Record<string, string>;
  approve: (request: Json) => Json;
  run: (ctx: { threadId: string; turn: (text: string) => Promise<void>; client: ReturnType<typeof startBridgeClient> }) => Promise<void>;
}

const allow = () => ({ behavior: "allow" });

const SCENARIOS: Scenario[] = [
  {
    name: "text-reply",
    approve: allow,
    run: ({ turn }) => turn("In two short sentences, say what a lotus flower is."),
  },
  {
    name: "tool-chain",
    seed: { "notes.txt": "lotus grows in mud\nlotus opens at dawn\nlotus closes at night\n" },
    approve: allow,
    run: ({ turn }) =>
      turn(
        "Do these steps in order, using one tool per step: 1) Read notes.txt. 2) Run `wc -l notes.txt` with Bash. " +
          "3) Use Write to create summary.md containing one line that summarises the notes. " +
          "4) Use Edit to change the word 'lotus' to 'Lotus' in the first line of notes.txt. Then reply with one sentence.",
      ),
  },
  {
    name: "tool-denied",
    approve: (request) =>
      request.toolName === "Bash" ? { behavior: "deny", message: "The user declined this command." } : allow(),
    run: ({ turn }) => turn("Run `rm -rf build` with the Bash tool. If it is refused, say so in one sentence."),
  },
  {
    // Claude's own Agent tool: the sub-agent's events carry parent_tool_use_id = the Agent call's id.
    name: "subagent",
    seed: { "notes.txt": "lotus grows in mud\nlotus opens at dawn\n" },
    approve: allow,
    run: ({ turn }) =>
      turn(
        "Use the Agent tool exactly once, with subagent_type general-purpose, to read notes.txt and report how many " +
          "lines it has. Do not read the file yourself. Then reply with one sentence.",
      ),
  },
  {
    name: "interrupted",
    approve: allow,
    run: async ({ threadId, client }) => {
      const done = client.waitFor(isSdkEvent("result"), "interrupted result");
      await client.request("turn/start", { threadId, text: "Write a 700-word essay about lotus flowers.", clientRequestId: "essay" });
      await client.waitFor(isTextDelta, "essay to start");
      await client.request("turn/interrupt", { threadId });
      await done;
    },
  },
];

function sanitize(line: string, cwd: string): string {
  const scrubbed = line.split(cwd).join("<cwd>").split(homedir()).join("<home>");
  const message = JSON.parse(scrubbed) as Json;
  const event = message.params?.event;
  if (event?.type === "system" && event.subtype === "init") {
    for (const key of INIT_LISTS) if (Array.isArray(event[key])) event[key] = [];
  }
  // Account usage and plan details are not test data.
  if (event?.type === "rate_limit_event") {
    event.rate_limit_info = { status: event.rate_limit_info?.status ?? "allowed", rateLimitType: "five_hour", resetsAt: 0 };
  }
  return JSON.stringify(message);
}

async function record(scenario: Scenario): Promise<number> {
  const cwd = mkdtempSync(join(tmpdir(), `lotus-chat-fixture-${scenario.name}-`));
  for (const [file, content] of Object.entries(scenario.seed ?? {})) writeFileSync(join(cwd, file), content);

  const lines: string[] = [];
  const client = startBridgeClient({
    minimalPath: true,
    raw: true,
    onRawLine: (line) => {
      const method = (JSON.parse(line) as Json).method;
      if (method === "thread/raw" || method === "thread/ended" || method === "interaction/request") lines.push(line);
    },
  });
  client.setApprovalPolicy(scenario.approve);
  const threadId = `fixture-${scenario.name}`;
  try {
    await client.request("initialize", {});
    await client.request("thread/start", { threadId, cwd, model: "haiku", permissionMode: "default" });
    const turn = async (text: string) => {
      const done = client.waitFor(isSdkEvent("result"), `result of ${scenario.name}`);
      await client.request("turn/start", { threadId, text, clientRequestId: `${scenario.name}-1` });
      await done;
    };
    await scenario.run({ threadId, turn, client });
    const ended = client.waitFor((m) => m.method === "thread/ended", "thread/ended");
    await client.request("thread/stop", { threadId });
    await ended;
  } finally {
    client.close();
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, `${scenario.name}.jsonl`), lines.map((l) => sanitize(l, cwd)).join("\n") + "\n");
  return lines.length;
}

const wanted = process.argv.slice(2);
for (const scenario of SCENARIOS.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
  const count = await record(scenario);
  console.log(`recorded ${scenario.name}: ${count} lines`);
}
process.exit(0);
