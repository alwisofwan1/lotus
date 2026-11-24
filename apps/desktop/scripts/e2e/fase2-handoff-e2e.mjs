#!/usr/bin/env bun
/**
 * Fase 2 E2E harness — cross-agent read/dispatch + rate-guard trip.
 *
 * Drives the live MCP-IPC choke point (`/v1/*` in src-tauri/src/mcp_ipc.rs) exactly the way the
 * MCP sidecar (scripts/lotus-mcp-server.mjs) does: read the discovery file for {port, secret},
 * then POST with `Authorization: Bearer <secret>`. This is the *live* half of the Fase 2 E2E
 * checklist — the app-free decision-layer half is the vitest in
 * `src/modules/codecanvas/services/__tests__/fase2-handoff-scenario.test.ts`.
 *
 * Prereq: Lotus is running (`bun run tauri:dev`) with at least TWO live Canvas Agent personas on
 * the canvas (Add Agent → defaults to live). The harness auto-discovers them from list-fleet.
 *
 * Usage:
 *   bun scripts/e2e/fase2-handoff-e2e.mjs                 # full sequence
 *   bun scripts/e2e/fase2-handoff-e2e.mjs --rate-guard    # only the 429 rate-guard trip
 *   bun scripts/e2e/fase2-handoff-e2e.mjs --pane <id>     # force the dispatch target
 *   LOTUS_MCP_IPC=/path/to/lotus-mcp-ipc.json bun scripts/e2e/fase2-handoff-e2e.mjs
 *
 * Exit code 0 = all assertions passed, 1 = a failure (CI-friendly).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors src-tauri/src/mcp_ipc.rs — keep in sync if the constants change there.
const DISPATCH_LIMIT = 6;
const DISPATCH_WINDOW_MS = 20_000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let failures = 0;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  \x1b[31m✗ ${msg}\x1b[0m`);
};
const step = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);
const assert = (cond, pass, why) => (cond ? ok(pass) : fail(`${pass} — ${why}`));

// --- discovery: same precedence the sidecar + dev/release split use -----------------------------
function loadIpcConfig() {
  const candidates = [
    process.env.LOTUS_MCP_IPC,
    join(homedir(), ".lotus-dev", "lotus-mcp-ipc.json"), // dev (bun run tauri:dev)
    join(homedir(), ".lotus", "lotus-mcp-ipc.json"), // release
    join(homedir(), ".claude", "lotus-mcp-ipc.json"), // sidecar legacy default
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      if (cfg?.port && cfg?.secret) return { cfg, path };
    } catch {
      /* try next */
    }
  }
  console.error(
    "\x1b[31mNo lotus-mcp-ipc.json found.\x1b[0m Is Lotus running? Looked in:\n  " +
      candidates.join("\n  "),
  );
  process.exit(1);
}

const { cfg, path: cfgPath } = loadIpcConfig();
const BASE = `http://127.0.0.1:${cfg.port}`;

async function call(route, body) {
  let res;
  try {
    res = await fetch(`${BASE}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    // Connection refused → the app advertised this port but isn't listening (stale ipc.json).
    return { status: 0, text: `connection failed: ${err?.message ?? err}`, json: undefined };
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

// --- harness ------------------------------------------------------------------------------------
async function main() {
  console.log(`\x1b[2mIPC: ${cfgPath} → ${BASE}\x1b[0m`);

  step("1. Ping the MCP-IPC server");
  const ping = await call("/v1/ping", {});
  assert(ping.status === 200, "server reachable", `got HTTP ${ping.status}: ${ping.text}`);
  if (ping.status !== 200) process.exit(1);

  step("2. List the canvas fleet (find live personas)");
  const fleet = await call("/v1/list-fleet", { verbose: true, scope: "all" });
  assert(fleet.status === 200, "list-fleet returns 200", `HTTP ${fleet.status}: ${fleet.text}`);
  const members = fleet.json?.fleet ?? [];
  const canvasLive = members.filter(
    (m) => String(m.workspace_id ?? "").startsWith("canvas:") && m.is_alive,
  );
  console.log(`    fleet: ${members.length} member(s); ${canvasLive.length} live canvas persona(s)`);
  for (const m of canvasLive) console.log(`      • ${m.display_name ?? m.pane_id} [${m.pane_id}] status=${m.status}`);

  const forced = opt("--pane");
  const target = forced
    ? canvasLive.find((m) => m.pane_id === forced) ?? { pane_id: forced, display_name: forced }
    : canvasLive[0];
  const reader = canvasLive.find((m) => m.pane_id !== target?.pane_id);

  if (!target) {
    fail("need at least 1 live canvas agent — Add Agent on the canvas (defaults to live), then rerun");
    process.exit(1);
  }

  if (!flag("--rate-guard")) {
    step(`3. Read tail output of "${target.display_name ?? target.pane_id}" (lotus_read_cell_output)`);
    const read = await call("/v1/read-cell-output", { pane_id: target.pane_id, tail_bytes: 2048 });
    assert(read.status === 200, "read-cell-output returns 200", `HTTP ${read.status}: ${read.text}`);
    const out = read.json?.output ?? read.json?.text ?? read.text ?? "";
    console.log(`    tail (${out.length} chars): ${JSON.stringify(out.slice(-160))}`);

    step(`4. Cross-agent dispatch → "${target.display_name ?? target.pane_id}" (lotus_dispatch_to_cell)`);
    if (!reader) console.log("    (only one live agent; dispatching to it as the handoff target)");
    // append_newline:false → paste the brief WITHOUT submitting, so the E2E probe doesn't burn a
    // real Claude turn. The rate guard still counts every dispatch.
    const dispatch = await call("/v1/dispatch-to-cell", {
      pane_id: target.pane_id,
      command: `# e2e handoff probe — context from ${reader?.display_name ?? "harness"}`,
      append_newline: false,
    });
    assert(dispatch.status === 200, "dispatch accepted", `HTTP ${dispatch.status}: ${dispatch.text}`);
  }

  step(`5. Trip the handoff rate guard (>${DISPATCH_LIMIT} dispatches / ${DISPATCH_WINDOW_MS / 1000}s → HTTP 429)`);
  const statuses = [];
  for (let i = 1; i <= DISPATCH_LIMIT + 1; i++) {
    const r = await call("/v1/dispatch-to-cell", {
      pane_id: target.pane_id,
      command: `# rate-guard probe ${i}`,
      append_newline: false, // paste-only, no real turn
    });
    statuses.push(r.status);
    console.log(`    dispatch ${i}/${DISPATCH_LIMIT + 1} → HTTP ${r.status}${r.status === 429 ? "  ⟵ guard tripped" : ""}`);
  }
  const allowed = statuses.slice(0, DISPATCH_LIMIT);
  const tripped = statuses[DISPATCH_LIMIT];
  assert(
    allowed.every((s) => s === 200),
    `first ${DISPATCH_LIMIT} dispatches allowed (200)`,
    `got ${JSON.stringify(allowed)}`,
  );
  assert(tripped === 429, `dispatch #${DISPATCH_LIMIT + 1} blocked with 429`, `got HTTP ${tripped}`);

  step(failures === 0 ? "\x1b[32mPASS\x1b[0m — Fase 2 live E2E green" : `\x1b[31mFAIL\x1b[0m — ${failures} assertion(s) failed`);
  console.log(
    "\x1b[2mNote: visual edge events (\"A read B\" / \"A handed off to B\") are UI-only — confirm them\n" +
      "on the canvas per plans/codespace-v2/e2e-fase2-manual.md. The rate guard resets after ~20s.\x1b[0m",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\x1b[31mharness error:\x1b[0m ${err?.stack ?? err}`);
  process.exit(1);
});
