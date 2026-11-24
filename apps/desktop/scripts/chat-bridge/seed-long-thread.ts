// Adds a finished 500-row thread to the dev chat store, to check that a long thread scrolls
// smoothly in the real WKWebView (plans/chat-runtime/PLAN.md, phase 3). Dev store only.
//
//   bun run scripts/chat-bridge/seed-long-thread.ts [path/to/chat.sqlite3]
//
// Start Lotus dev once first, so the store and its schema exist. Reopen /chat to see the thread.

// @ts-expect-error -- this package has no Bun types; the script only runs under bun.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { threadEventSchema, type ThreadEvent } from "../../src/modules/chat/domain/thread-event";

const TURNS = 100; // 5 rows each
const dbPath = process.argv[2] ?? path.join(homedir(), ".lotus-dev", "chat", "chat.sqlite3");
if (!existsSync(dbPath)) throw new Error(`${dbPath} does not exist; start Lotus dev once first`);

const cwd = process.cwd();
const reply = (n: number) =>
  `Turn ${n}: here is what I found.\n\n- \`src/file-${n}.ts\` exports **${n} helpers**\n- See [the docs](https://example.com/${n})\n\n` +
  "```ts\n" +
  `export function helper${n}(value: number): number {\n  return value * ${n};\n}\n` +
  "```\n\n" +
  `That is all for turn ${n}.`;

function turnEvents(n: number): ThreadEvent[] {
  const turnId = `seed-turn-${n}`;
  const done = (id: string, extra: object) => [
    { type: "item/started", turnId, item: { id, status: "running", ...extra } },
    { type: "item/completed", turnId, item: { id, status: "completed", ...extra } },
  ];
  return [
    { type: "turn/started", turnId, input: { text: `Question ${n}: what does file ${n} do?`, clientRequestId: `seed-${n}` } },
    ...done(`${turnId}-read`, { kind: "fileRead", path: `${cwd}/src/file-${n}.ts`, lineCount: 40 }),
    ...done(`${turnId}-cmd`, { kind: "command", command: `wc -l src/file-${n}.ts`, description: null, output: "40" }),
    ...done(`${turnId}-a1`, { kind: "agentMessage", text: `Reading file ${n} first.` }),
    ...done(`${turnId}-edit`, { kind: "fileChange", path: `${cwd}/src/file-${n}.ts`, change: "edit", patch: null }),
    ...done(`${turnId}-a2`, { kind: "agentMessage", text: reply(n) }),
    { type: "turn/completed", turnId, status: "completed", error: null, usage: null },
  ] as ThreadEvent[];
}

const db = new Database(dbPath);
const threadId = crypto.randomUUID();
const now = Date.now();
db.transaction(() => {
  db.run(
    "INSERT INTO chat_threads (id, cwd, model, permission_mode, provider_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    [threadId, cwd, "seed", "default", now, now],
  );
  const insert = db.prepare("INSERT INTO chat_events (thread_id, seq, at, kind, event) VALUES (?, ?, ?, ?, ?)");
  let seq = 0;
  for (let n = 1; n <= TURNS; n++) {
    for (const event of turnEvents(n)) {
      threadEventSchema.parse(event); // the store only ever holds valid events
      seq += 1;
      insert.run(threadId, seq, now + seq, event.type, JSON.stringify(event));
    }
  }
})();
console.log(`Seeded thread ${threadId}: ${TURNS} turns, ${TURNS * 5} rows, in ${dbPath}`);
