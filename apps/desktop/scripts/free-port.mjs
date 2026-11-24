#!/usr/bin/env node
// Free the Next dev-server port before starting it.
//
// `tauri dev` runs `PORT=3001 npm run dev` as its beforeDevCommand. When a
// previous dev session is interrupted, Tauri does not always reap the Next child
// tree it spawned, so an orphaned dev server keeps listening on 3001 and the next
// `tauri dev` dies immediately with EADDRINUSE. This runs as npm's `predev` hook,
// so it clears a stale listener before Next tries to bind.
//
// Best-effort by design: it never fails the run. If nothing is listening (the
// normal clean start), it is a silent no-op; if it cannot inspect or kill, it
// gives up quietly rather than blocking dev.

import { execFileSync } from "node:child_process";

const port = Number(process.env.PORT) || 3001;
const isWindows = process.platform === "win32";

function listenerPids(p) {
  try {
    if (isWindows) {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      return [
        ...new Set(
          out
            .split(/\r?\n/)
            .filter((line) => line.includes(`:${p} `) && /LISTENING/i.test(line))
            .map((line) => line.trim().split(/\s+/).pop())
            .filter((pid) => pid && pid !== "0"),
        ),
      ];
    }
    // lsof exits non-zero when nothing is listening — that throws and we treat it
    // as "clean start, nothing to free".
    const out = execFileSync("lsof", ["-tnP", `-iTCP:${p}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function kill(pid) {
  try {
    if (isWindows) {
      // /T kills the child tree too, so the `next dev` wrapper cannot respawn the
      // server on the same port right after we free it.
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // SIGKILL: a dev server is disposable and we need the port released now, not
      // after a graceful-shutdown grace period that would race the new bind.
      process.kill(Number(pid), "SIGKILL");
    }
    return true;
  } catch {
    return false; // already gone or not ours — fine.
  }
}

const pids = listenerPids(port);
for (const pid of pids) {
  if (kill(pid)) console.log(`[free-port] freed :${port} — killed stale dev server pid ${pid}`);
}
process.exit(0);
