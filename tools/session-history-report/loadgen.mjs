#!/usr/bin/env node
// Fase 0 synthetic load for `plans/session-history-hardening`.
//
// Answers ONE question, and deliberately only one: **at what output rate does a pane
// start losing bytes between two polls?** The plan's central hypothesis is that the
// 64KB ring plus a 400ms poll means anything past roughly 160KB/s produces permanent
// gaps rather than occasional ones. That is a mechanical property of the transport —
// bytes do not care whether an agent or a generator produced them — so measuring it
// synthetically is honest.
//
// **What this must never be used for.** Assistant message lengths (`body.length`) and
// events-per-turn. Both are properties of how agents actually behave, and a synthetic
// number there would not merely be useless — it would pollute the same series the real
// measurement writes to, and the p99 a new cap gets chosen from would be fiction.
//
// Run it INSIDE a Lotus terminal pane, so its output travels the real path:
//
//   node tools/session-history-report/loadgen.mjs            # rate ladder, ~3.5 min
//   node tools/session-history-report/loadgen.mjs --paint    # screen-repaint shaped
//   node tools/session-history-report/loadgen.mjs --step 10s --max 400
//
// It writes `loadgen.step` records into the same diagnostics log, so the reporter can
// line each rate up against the `cell.truncated` events it did or did not cause.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Rates to climb, in KB/s. Straddles the ~160KB/s the plan predicts is the cliff. */
const DEFAULT_LADDER = [10, 25, 50, 100, 160, 250, 400, 800];

/** How long to hold each rate. The desktop sampler ticks every 10s, so 30s is three
 *  samples per step — enough that one slow tick cannot decide a step on its own. */
const DEFAULT_STEP_MS = 30_000;

/** How often to write within a step. Small enough to look like a stream rather than
 *  eight bursts a second, large enough not to spend the whole budget on syscalls. */
const TICK_MS = 50;

function parseArgs(argv) {
  const out = { paint: false, stepMs: DEFAULT_STEP_MS, ladder: DEFAULT_LADDER };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--paint") out.paint = true;
    else if (arg === "--step") {
      const raw = argv[++i] ?? "";
      const ms = raw.endsWith("s") ? Number(raw.slice(0, -1)) * 1000 : Number(raw);
      if (Number.isFinite(ms) && ms > 0) out.stepMs = ms;
    } else if (arg === "--max") {
      const max = Number(argv[++i]);
      if (Number.isFinite(max)) out.ladder = DEFAULT_LADDER.filter((r) => r <= max);
    }
  }
  return out;
}

/** The diagnostics log this instance writes. Dev unless told otherwise — a `tauri:dev`
 *  build is what carries the counters, so that is the default rather than a guess. */
function logPath() {
  const stateDir = process.env["LOTUS_STATE_DIR"]
    ? process.env["LOTUS_STATE_DIR"]
    : path.join(os.homedir(), process.env["LOTUS_PROFILE"] === "release" ? ".lotus" : ".lotus-dev");
  return path.join(stateDir, "diagnostics", "session-history.jsonl");
}

function record(metric, value, labels) {
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      JSON.stringify({ at: Date.now(), layer: "loadgen", metric, value, labels }) + "\n",
    );
  } catch {
    // The load must not die because the log could not be written; the pane output is
    // still the thing being measured.
  }
}

/** One line of filler, sized so a chunk is a whole number of them. */
const FILLER = `${"lotus-loadgen ".repeat(5)}\n`;

/** Widest screen this paints. Rows are the unit that scales; a row is never cut in half
 *  because that would leave the emulator mid-escape-sequence — a different failure than
 *  the one being measured. */
const PAINT_ROWS_MAX = 24;

/** A screenful of repaint — cursor home, then coloured rows.
 *
 *  Shaped like what a TUI agent actually emits, because that is the traffic the ring
 *  was sized against: `AnsiGuard.paintsScreen` keys on cursor addressing, and it is
 *  what makes the phone rebuild its emulator (`terminal.rebuild`). A plain byte stream
 *  never exercises that path at all. */
function paintFrame(rows) {
  let out = "\x1b[H";
  for (let y = 0; y < rows; y += 1) {
    out += `\x1b[${y + 1};1H\x1b[3${(y % 7) + 1}mrow ${String(y).padStart(3, "0")} `;
    out += "░▒▓█".repeat(14);
    out += "\x1b[0m";
  }
  return out;
}

/** Bytes one painted row costs, measured rather than assumed — the block characters are
 *  three bytes each in UTF-8, so counting characters would be off by roughly a third. */
const PAINT_ROW_BYTES = Math.round(
  (Buffer.byteLength(paintFrame(PAINT_ROWS_MAX)) - Buffer.byteLength("\x1b[H")) / PAINT_ROWS_MAX,
);

function chunkFor(bytes, paint) {
  if (paint) {
    // **Rows scale to the budget; whole frames do not.** A first version emitted whole
    // 24-row frames and clamped to at least one, which put a floor of about 94KB/s under
    // every step — the first live run asked for 10KB/s and achieved 88, because the
    // smallest thing it knew how to send was already that big. The ladder's bottom rungs
    // measured nothing. Scaling by row keeps every escape sequence intact and still lets
    // a step be small.
    const rows = Math.max(1, Math.min(PAINT_ROWS_MAX, Math.round(bytes / PAINT_ROW_BYTES)));
    const frame = paintFrame(rows);
    const times = Math.max(1, Math.round(bytes / Buffer.byteLength(frame)));
    return frame.repeat(times);
  }
  const times = Math.max(1, Math.round(bytes / Buffer.byteLength(FILLER)));
  return FILLER.repeat(times);
}

/** Write, respecting backpressure. Resolves once the bytes are accepted. */
function write(text) {
  return new Promise((resolve) => {
    if (process.stdout.write(text)) resolve();
    else process.stdout.once("drain", resolve);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runStep(rateKbs, stepMs, paint) {
  const targetPerTick = Math.round((rateKbs * 1024 * TICK_MS) / 1000);
  const chunk = chunkFor(targetPerTick, paint);
  const chunkBytes = Buffer.byteLength(chunk);

  const started = Date.now();
  let written = 0;
  // Achieved rate is tracked and reported rather than assumed: a PTY under
  // backpressure will not go as fast as it is asked to, and a step that only reached
  // half its target must not be read as evidence about the target.
  while (Date.now() - started < stepMs) {
    const tickStart = Date.now();
    await write(chunk);
    written += chunkBytes;
    const spent = Date.now() - tickStart;
    if (spent < TICK_MS) await sleep(TICK_MS - spent);
  }
  const elapsed = (Date.now() - started) / 1000;
  return { written, achievedKbs: Math.round(written / 1024 / elapsed) };
}

async function main() {
  const { paint, stepMs, ladder } = parseArgs(process.argv.slice(2));
  const paneId = process.env["LOTUS_PANE_ID"] ?? "";

  if (!paneId) {
    // Not fatal: the rate ladder is still measurable from `pty.bytes`. But without a
    // pane id the phone-side and host-side series cannot be joined to it, so say so
    // rather than let a half-usable run look complete.
    process.stderr.write(
      "\x1b[33m[loadgen] LOTUS_PANE_ID is not set — run this inside a Lotus terminal pane,\n" +
        "          otherwise host/pocket counters cannot be attributed to this load.\x1b[0m\n",
    );
  }

  const mode = paint ? "paint" : "stream";
  process.stderr.write(
    `\x1b[36m[loadgen] mode=${mode} steps=${ladder.join(",")}KB/s hold=${stepMs / 1000}s ` +
      `log=${logPath()}\x1b[0m\n`,
  );
  record("loadgen.begin", ladder.length, { mode, paneId });

  const results = [];
  for (const rate of ladder) {
    record("loadgen.step", rate * 1024, { mode, paneId, phase: "start", targetKbs: `${rate}` });
    const { written, achievedKbs } = await runStep(rate, stepMs, paint);
    record("loadgen.step", written, {
      mode,
      paneId,
      phase: "end",
      targetKbs: `${rate}`,
      achievedKbs: `${achievedKbs}`,
    });
    results.push({ rate, achievedKbs, written });
    process.stderr.write(
      `\x1b[36m[loadgen] target ${String(rate).padStart(4)}KB/s → achieved ` +
        `${String(achievedKbs).padStart(4)}KB/s (${written} bytes)\x1b[0m\n`,
    );
  }

  record("loadgen.end", results.length, { mode, paneId });
  process.stderr.write("\x1b[36m[loadgen] done. Now run: bun run diagnostics:report\x1b[0m\n");
}

main();
