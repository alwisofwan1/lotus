#!/usr/bin/env node
// Fase 0 reader for `plans/session-history-hardening`.
//
// The three layers each write the same JSONL shape to their own machine — desktop and host
// under their state dir, pocket exported off the phone. This merges whatever it is given
// and prints the table `issues/01` asks for.
//
// It answers questions, not "here are your counters". Every section below maps to a
// numbered measurement in that issue, and the numbers it prints are the ones Fase 2–4 are
// forbidden from guessing.
//
//   node tools/session-history-report/report.mjs [file ...]
//
// With no arguments it reads the desktop log from both instance profiles.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = [
  path.join(os.homedir(), ".lotus", "diagnostics", "session-history.jsonl"),
  path.join(os.homedir(), ".lotus-dev", "diagnostics", "session-history.jsonl"),
];

function load(files) {
  const records = [];
  const read = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    read.push(file);
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // One torn line — a flush interrupted by a kill — must not discard the run.
      }
    }
  }
  return { records, read };
}

const pick = (records, metric) => records.filter((r) => r.metric === metric);
const sum = (records) => records.reduce((acc, r) => acc + (r.value ?? 0), 0);
const groupBy = (records, key) => {
  const out = new Map();
  for (const r of records) {
    const k = r.labels?.[key] ?? "—";
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
};

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

function hours(records) {
  if (records.length < 2) return 0;
  const times = records.map((r) => r.at).sort((a, b) => a - b);
  return (times[times.length - 1] - times[0]) / 3_600_000;
}

function section(title) {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

function main() {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
  const { records, read } = load(files);

  if (read.length === 0) {
    console.log("No diagnostics files found. Looked at:");
    for (const f of files) console.log(`  ${f}`);
    console.log("\nRun the app with LOTUS_DIAGNOSTICS unset, then try again.");
    return;
  }

  const span = hours(records);
  console.log(`Fase 0 — session-history measurements`);
  console.log(`Files   : ${read.join(", ")}`);
  console.log(`Records : ${records.length}`);
  console.log(`Span    : ${span.toFixed(2)}h`);
  console.log(`Restarts: ${pick(records, "app.start").length}`);

  // ── Terminal ────────────────────────────────────────────────────────────────────────
  // Q: can a pane outrun the 64KB ring between two 400ms polls? At 400ms, 64KB means
  // ~160KB/s is the point where gaps stop being occasional and become permanent.
  section("Terminal — PTY output rate per runner");
  const bytes = pick(records, "pty.bytes");
  if (bytes.length === 0) {
    console.log("  no samples");
  } else {
    console.log(`  ${"runner".padEnd(12)} ${"total".padStart(12)} ${"peak 10s".padStart(12)} ${"peak B/s".padStart(11)}  verdict`);
    for (const [runner, rs] of groupBy(bytes, "runner")) {
      const peak = Math.max(...rs.map((r) => r.value));
      const perSec = Math.round(peak / 10); // sampler interval
      const verdict = perSec > 160_000 ? "OUTRUNS the ring" : "within ring";
      console.log(
        `  ${runner.padEnd(12)} ${String(sum(rs)).padStart(12)} ${String(peak).padStart(12)} ${String(perSec).padStart(11)}  ${verdict}`,
      );
    }
  }

  section("Terminal — gaps reported to the phone (layer: host)");
  const truncated = pick(records, "cell.truncated");
  if (truncated.length === 0) {
    console.log("  none recorded (host layer not merged in, or no gaps)");
  } else {
    const perHour = span > 0 ? (truncated.length / span).toFixed(1) : "—";
    console.log(`  events: ${truncated.length}  (${perHour}/h)`);
    console.log(`  bytes lost: ${sum(truncated)}`);
    for (const [pane, rs] of groupBy(truncated, "paneId")) {
      console.log(`    ${pane.padEnd(28)} ${rs.length} gaps, ${sum(rs)} bytes`);
    }
  }

  // ── Rate ladder ─────────────────────────────────────────────────────────────────────
  // Only present when `loadgen.mjs` has been run. It turns the ring question from a
  // yes/no into a curve: which target rate is the first to produce gaps.
  const steps = pick(records, "loadgen.step");
  if (steps.length) {
    section("Terminal — synthetic rate ladder (where the ring starts losing bytes)");
    // **Paired by walking in time, not by searching.** A first version matched each
    // start to the first later end with the same target, which quietly crossed runs:
    // the live session had a `stream` ladder interrupted mid-step and a `paint` ladder
    // after it, so an orphaned `stream` start borrowed the `paint` run's end and the
    // achieved rate reported belonged to different traffic entirely. Mode is part of the
    // key, and a step still open when the next one starts is dropped rather than paired.
    // Any host-side activity proves a client was subscribed during that moment; without
    // one, the gap column is unmeasured rather than zero.
    const watchActivity = [...pick(records, "poll.tick"), ...pick(records, "bytes.served")];
    // **The cliff is a property of the run, not of the file.** Every ladder ever run lives
    // in the same log, so a version that scanned all of them and reported the first cliff
    // it found kept announcing a cliff that a later fix had already moved — reporting
    // history as the present. Runs are delimited by `loadgen.begin`, and only the last one
    // describes the code as it stands.
    const runStarts = pick(records, "loadgen.begin")
      .map((r) => r.at)
      .sort((a, b) => a - b);
    const runIndexOf = (at) => runStarts.filter((s) => s <= at).length;
    const latestRun = runStarts.length;

    const ordered = [...steps].sort((a, b) => a.at - b.at);
    const pending = new Map();
    const pairs = [];
    for (const step of ordered) {
      const key = `${step.labels?.mode ?? "?"}|${step.labels?.targetKbs ?? "?"}`;
      if (step.labels?.phase === "start") {
        pending.set(key, step);
      } else if (step.labels?.phase === "end") {
        const start = pending.get(key);
        if (start) {
          pairs.push({ start, end: step });
          pending.delete(key);
        }
      }
    }
    if (pending.size > 0) {
      console.log(`  (${pending.size} step(s) never finished — interrupted run, not shown)`);
    }
    console.log(
      `  ${"".padEnd(1)} ${"mode".padEnd(5)} ${"target".padStart(8)} ${"achieved".padStart(9)} ${"gaps".padStart(6)} ${"bytes lost".padStart(11)}  verdict   (→ = latest run)`,
    );
    let cliff = null;
    // Highest rate the latest run actually sustained without loss — the honest ceiling
    // when no cliff was reached at all.
    let cleared = 0;
    for (const { start, end } of pairs) {
      const target = start.labels.targetKbs;
      const mode = start.labels.mode ?? "?";
      // Gaps attributed to a step are the ones inside its own window — the only honest
      // way to tie a `cell.truncated` to the rate that caused it.
      const inWindow = truncated.filter((t) => t.at >= start.at && t.at <= end.at);
      const achieved = end.labels?.achievedKbs ?? "?";

      // **"No gaps" and "nobody was looking" are not the same claim**, and conflating them
      // is the exact failure this plan exists to stop. A gap is only ever computed for a
      // pane some client has subscribed to; with no watcher the host records nothing at
      // all, and a row that printed `clean` for that window was reporting the absence of
      // an observer as the absence of loss. The live run had fourteen such rows above two
      // real ones. Presence of any host activity inside the window is the discriminator.
      const watched = watchActivity.some((h) => h.at >= start.at && h.at <= end.at);
      const verdict = !watched ? "not measured" : inWindow.length > 0 ? "LOSES BYTES" : "clean";
      const run = runIndexOf(start.at);
      if (run === latestRun && watched && inWindow.length > 0 && cliff === null) {
        cliff = { target, achieved };
      }
      if (run === latestRun && watched && inWindow.length === 0) {
        cleared = Math.max(cleared, Number(achieved) || 0);
      }
      // A step whose achieved rate landed far from its target measured the machine's
      // ceiling, not the target — say so on the row rather than let it read as evidence.
      const drift =
        Number(achieved) > 0 && Math.abs(Number(achieved) - Number(target)) / Number(target) > 0.25
          ? "  ← target not met"
          : "";
      console.log(
        `  ${(runIndexOf(start.at) === latestRun ? "→" : " ")} ${mode.padEnd(5)} ${(target + "KB/s").padStart(8)} ${(achieved + "KB/s").padStart(9)} ` +
          `${String(inWindow.length).padStart(6)} ${String(sum(inWindow)).padStart(11)}  ${verdict}${drift}`,
      );
    }
    if (cliff) {
      console.log(`\n  First rate to lose bytes: ${cliff.target}KB/s (achieved ${cliff.achieved}KB/s).`);
      // The plan predicted ~160KB/s from 64KB ÷ 400ms. Say plainly whether the machine
      // agreed, rather than restating the prediction as if it were the result.
      const predicted = 160;
      const measured = Number(cliff.target);
      if (Number.isFinite(measured) && measured !== predicted) {
        console.log(
          `  The plan predicted ~${predicted}KB/s (64KB ÷ 400ms); measured is ${measured}KB/s.`,
        );
      } else {
        console.log(`  Matches the plan's ~${predicted}KB/s prediction (64KB ÷ 400ms).`);
      }
      console.log(`  This is the number Fase 2 sizes against.`);
    } else if (cleared > 0) {
      console.log(`\n  No loss at any rate in the latest run — highest sustained: ${cleared}KB/s.`);
      console.log(`  The cliff is above that, so this run puts a floor under it rather than finding it.`);
    } else {
      console.log(`\n  No gaps at any rate reached. Either the ladder did not climb high enough`);
      console.log(`  (check the achieved column — a PTY under backpressure may never hit its target),`);
      console.log(`  or nothing was subscribed to this pane. Gaps are only reported to a watching phone.`);
    }
  }

  section("Terminal — scrollback thrown away by the phone (layer: pocket)");
  const rebuilds = pick(records, "terminal.rebuild");
  const cleared = pick(records, "buffer.cleared");
  console.log(`  emulator rebuilds : ${rebuilds.length}`);
  console.log(`  buffer clears     : ${cleared.length} (${sum(cleared)} bytes held at the time)`);
  if (rebuilds.length) {
    console.log(`  bytes replayed on rebuild — median ${quantile(rebuilds.map((r) => r.value).sort((a, b) => a - b), 0.5)}`);
    console.log(`  (each rebuild discards up to 4000 lines and replays only what is shown)`);
  }

  // `output.evicted` and `output.missing` are deliberately different claims — see the
  // comment on `OutputBuffer.evictedBytes`. Summing them once produced a report of
  // "34823344 bytes never arrived" over output the operator was looking at, so they stay
  // apart here too.
  const evictedBytes = pick(records, "output.evicted");
  const missingBytes = pick(records, "output.missing");
  console.log(`  evicted locally   : ${sum(evictedBytes)} bytes — drawn, then dropped from the replay snapshot`);
  console.log(`  missing from host : ${sum(missingBytes)} bytes — a real hole; the ring had moved on`);

  section("Chat — entries dropped on the phone (layer: pocket)");
  const phoneDropped = pick(records, "transcript.dropped");
  console.log(`  entries dropped: ${phoneDropped.length}`);
  if (phoneDropped.length) {
    // The phone mirrors the host's 60-entry cap on purpose, so its own drops confirm
    // whether raising the host alone would have been enough. It would not.
    for (const [pane, rs] of groupBy(phoneDropped, "paneId")) {
      // `sinceCreate` on the FIRST drop is the answer — how many live frames this cell
      // accepted before history started falling off the front. Later drops just count up.
      const fit = rs[0]?.labels?.sinceCreate;
      console.log(`    ${pane.padEnd(28)} ${rs.length} dropped${fit ? `, first after ${fit} accepted` : ""}`);
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────────────────
  // Q: how many turns does Chat actually remember? MAX_ENTRIES_PER_PANE's own comment
  // guesses "roughly 5-30 events" per turn — this replaces the guess.
  section("Chat — transcript ring pressure");
  const appended = pick(records, "transcript.appended");
  const evicted = pick(records, "transcript.evicted");
  console.log(`  entries appended : ${appended.length}`);
  console.log(`  entries evicted  : ${evicted.length}`);
  if (appended.length) {
    const lossPct = ((evicted.length / appended.length) * 100).toFixed(1);
    console.log(`  lost to the 60-entry cap: ${lossPct}%`);
  }
  for (const [pane, rs] of groupBy(appended, "paneId")) {
    const paneEvictions = evicted.filter((e) => e.labels?.paneId === pane);
    if (paneEvictions.length === 0) continue;
    // Events that fit before the ring started dropping — the concrete answer to
    // "how far back can Chat see".
    const firstEvictionAt = Math.min(...paneEvictions.map((e) => e.at));
    const before = rs.filter((r) => r.at <= firstEvictionAt).length;
    console.log(`    ${pane.padEnd(28)} ${before} events fit, then ${paneEvictions.length} dropped`);
  }

  section("Chat — assistant message lengths vs the 8000-byte cap");
  const bodies = pick(records, "body.length");
  if (bodies.length === 0) {
    console.log("  no bodies recorded");
  } else {
    const cut = bodies.filter((b) => b.labels?.truncated === "true");
    const lens = bodies.map((b) => b.value).sort((a, b) => a - b);
    console.log(`  messages: ${bodies.length}, truncated: ${cut.length} (${((cut.length / bodies.length) * 100).toFixed(1)}%)`);
    console.log(`  length p50 ${quantile(lens, 0.5)}  p90 ${quantile(lens, 0.9)}  p99 ${quantile(lens, 0.99)}  max ${lens[lens.length - 1]}`);
    console.log(`  (payload.rs cites 15.8% over 1000 bytes from 279 messages in Aug 2026 —`);
    console.log(`   this is the re-measurement, and p99 is what a new cap follows from)`);
  }

  section("Chat — hook events dropped before they reached anything");
  const skipped = pick(records, "drop.skipped_full");
  console.log(`  drop.skipped_full: ${skipped.length}`);
  if (skipped.length === 0) {
    console.log("  (the 1000-file soft cap never bit — theoretical, not a real loss path)");
  }

  section("Chat — history lost to restarts");
  const starts = pick(records, "app.start").length;
  console.log(`  app starts: ${starts}`);
  console.log(`  TranscriptStore is in-memory, so each start began with an empty Chat`);
  console.log(`  for every live pane. That is the cost persistence would remove.`);

  console.log("");
}

main();
