#!/usr/bin/env node
// Fase 0 stand-in for a watching phone (`plans/session-history-hardening/issues/01`).
//
// **Why this has to exist.** `cell.truncated` is not something the desktop can observe.
// It is computed by the host's poller, and the poller only reads panes that a client has
// `subscribe`d to — with nobody watching, `subscribedPanes()` is empty and every host
// counter stays at zero no matter how much output a pane produces. The first live run
// missed exactly this: 177KB/s went through a real pane and the gap column stayed blank,
// because there was no reader for a gap to be reported to.
//
// So this speaks the same `/m/*` protocol Pocket does — pair, open the stream, subscribe —
// and then just holds the subscription open. It measures nothing itself; it makes the
// host's own measurements possible.
//
// **Not a substitute for the phone.** It cannot produce `terminal.rebuild`,
// `output.evicted` or `output.missing`, which are properties of how Pocket renders. It
// answers the ring question and nothing else.
//
//   node tools/session-history-report/subscriber.mjs --code ABC123
//   node tools/session-history-report/subscriber.mjs --pane canvas:cp_x:y
//
// The pairing code comes from the desktop's mobile pairing screen. It is needed once —
// the device token is cached afterwards, so later runs need no code at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_HOST = "http://192.168.1.11:8787";

function parseArgs(argv) {
  const out = { host: DEFAULT_HOST, code: null, pane: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--code") out.code = argv[++i] ?? null;
    else if (argv[i] === "--host") out.host = argv[++i] ?? DEFAULT_HOST;
    else if (argv[i] === "--pane") out.pane = argv[++i] ?? null;
  }
  return out;
}

function stateDir() {
  return (
    process.env["LOTUS_STATE_DIR"] ??
    path.join(os.homedir(), process.env["LOTUS_PROFILE"] === "release" ? ".lotus" : ".lotus-dev")
  );
}

/** Where the device token is cached. It is a bearer credential, so 0600 and never in the
 *  repo — the same treatment `mobile-devices.json` beside it gets. */
const tokenPath = () => path.join(stateDir(), "diagnostics", "subscriber-token.json");

function readToken(host) {
  try {
    const saved = JSON.parse(fs.readFileSync(tokenPath(), "utf8"));
    return saved.host === host ? saved.deviceToken : null;
  } catch {
    return null;
  }
}

function saveToken(host, deviceToken) {
  const file = tokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ host, deviceToken }, null, 2), { mode: 0o600 });
}

async function pair(host, code) {
  const res = await fetch(`${host}/m/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingCode: code, deviceName: "fase-0 subscriber" }),
  });
  if (!res.ok) {
    throw new Error(`pair failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()).deviceToken;
}

async function bootstrap(host, token) {
  const res = await fetch(`${host}/m/bootstrap`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`bootstrap failed: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const { host, code, pane } = parseArgs(process.argv.slice(2));

  let token = readToken(host);
  if (!token) {
    if (!code) {
      console.error(
        `No cached token for ${host}.\n` +
          `Generate a pairing code on the desktop's mobile pairing screen, then:\n` +
          `  node tools/session-history-report/subscriber.mjs --code <CODE>`,
      );
      process.exit(1);
    }
    token = await pair(host, code);
    saveToken(host, token);
    console.log(`paired with ${host}; token cached, no code needed next time`);
  }

  const boot = await bootstrap(host, token);
  const cells = boot.cells ?? [];

  // **An empty fleet is not a reason to refuse when a pane was named.** `/api/fleet` is
  // fed by a snapshot the desktop UI pushes, so it reads empty until a board is on
  // screen (`fleet.rs` says so out loud) — and a subscription does not need the list at
  // all, only an id. A first version bailed here and made a listing problem look like a
  // subscription problem.
  const target = pane ?? cells.map((c) => c.paneId).find(Boolean);
  if (!target) {
    console.error(
      "host reports no cells and no --pane was given.\n" +
        "Open a board on that instance, or pass --pane <paneId> explicitly.",
    );
    process.exit(1);
  }
  if (cells.length === 0) {
    console.log(`fleet snapshot is empty (no board on screen) — subscribing to ${target} anyway`);
  } else {
    console.log(`cells: ${cells.length}`);
    for (const c of cells) {
      console.log(`  ${c.paneId === target ? "→" : " "} ${c.paneId}  ${c.title ?? ""}`);
    }
    if (!cells.some((c) => c.paneId === target)) {
      // Said plainly rather than silently: subscribing to a pane this host does not know
      // yields a stream that is valid and forever empty, which is the hardest kind of
      // nothing to debug.
      console.log(`\n\x1b[33mwarning: ${target} is not in this host's fleet — expect no output.\x1b[0m`);
    }
  }

  const wsUrl = `${host.replace(/^http/, "ws")}/m/stream?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);

  let bytes = 0;
  let chunks = 0;
  let gaps = 0;
  let gapBytes = 0;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "subscribe", paneId: target }));
    console.log(`\nsubscribed to ${target} — the host is now polling it.`);
    console.log(`Run the ladder in that pane, then Ctrl-C here.\n`);
  });

  ws.addEventListener("message", (ev) => {
    let frame;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (frame.type === "cell.output") {
      chunks += 1;
      bytes += Buffer.byteLength(frame.chunk ?? "", "utf8");
    } else if (frame.type === "cell.truncated") {
      gaps += 1;
      gapBytes += (frame.servedFromByte ?? 0) - (frame.requestedFromByte ?? 0);
      // Printed as it happens, because seeing the first one is the moment the ring
      // question stops being theoretical.
      console.log(
        `\x1b[33mGAP  ${gaps}: ${frame.servedFromByte - frame.requestedFromByte} bytes skipped\x1b[0m`,
      );
    }
  });

  ws.addEventListener("close", () => {
    console.log("\nstream closed");
    process.exit(0);
  });
  ws.addEventListener("error", (e) => {
    console.error("stream error:", e.message ?? e);
    process.exit(1);
  });

  const tally = setInterval(() => {
    process.stdout.write(
      `\rchunks ${chunks}  bytes ${bytes}  gaps ${gaps} (${gapBytes} bytes lost)   `,
    );
  }, 1000);

  process.on("SIGINT", () => {
    clearInterval(tally);
    console.log(`\n\nfinal: ${chunks} chunks, ${bytes} bytes, ${gaps} gaps, ${gapBytes} bytes lost`);
    console.log("Now run: bun run diagnostics:report");
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
