import { describe, expect, it, beforeAll } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const INSTALL = join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh");

/**
 * The installer's whole value is that it refuses, so what is tested is the refusals.
 * `--preflight-only` exists for exactly this: no sudo, no systemd, no writes.
 *
 * `--login-path` replaces the login-shell probe with a directory of fake executables.
 * Without that seam these assertions would be about the developer's own machine —
 * which has claude and bun, and so would pass every check by accident.
 */
interface Result { code: number; out: string }

/**
 * `--dist-dir` points at an empty directory by default: this repo's own
 * `packages/host/dist/lotus-remote-bin` exists on any machine that has run
 * `build:bundle`, and without this the runtime checks would silently assert about
 * the developer's build output instead of about the script.
 */
async function preflight(args: string[]): Promise<Result> {
  const distDir = args.includes("--dist-dir")
    ? []
    : ["--dist-dir", mkdtempSync(join(tmpdir(), "lotus-dist-"))];
  const mode = args.includes("--print-unit") ? [] : ["--preflight-only"];
  try {
    const { stdout, stderr } = await run("bash", [INSTALL, ...mode, ...distDir, ...args]);
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** A build sitting in the default dist dir is picked up without being named. */
async function preflightWithDist(dist: string, args: string[]): Promise<Result> {
  return preflight(["--dist-dir", dist, ...args]);
}

function fakeBin(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lotus-bin-"));
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\necho '3.4'\n");
    chmodSync(path, 0o755);
  }
  return dir;
}

/** A runner that resolves but cannot run — the shape of a JS CLI with no node. */
function brokenBin(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\necho \"/usr/bin/env: 'node': No such file or directory\" >&2\nexit 127\n");
  chmodSync(path, 0o755);
  return dir;
}

function envFile(lines: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lotus-env-"));
  const path = join(dir, "lotus-host.env");
  writeFileSync(path, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return path;
}

const GOOD_ENV = {
  LOTUS_MODE: "standalone",
  LOTUS_MOBILE_BIND: "127.0.0.1:8787",
  LOTUS_MOBILE_ADMIN_SECRET: "deadbeef",
};

describe("install.sh preflight", () => {
  let full: string;
  beforeAll(() => { full = fakeBin(["claude", "codex", "bun"]); });

  it("passes on a machine that has everything", async () => {
    const res = await preflight(["--login-path", full, "--env-file", envFile(GOOD_ENV)]);
    expect(res.out).toContain("Preflight passed");
    expect(res.code).toBe(0);
  });

  it("warns about agents a tmux-era host left behind, without refusing", async () => {
    const bin = fakeBin(["claude", "codex", "bun"]);
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nprintf 'lotus-a1\\nworkspace\\nlotus-b2\\n'\n");
    chmodSync(join(bin, "tmux"), 0o755);
    const res = await preflight(["--login-path", bin, "--env-file", envFile(GOOD_ENV)]);
    expect(res.out).toMatch(/2 agent session\(s\) still run in tmux/);
    expect(res.out).toContain("Preflight passed");
    expect(res.code).toBe(0);
  });

  it("refuses when no runner is on the login PATH", async () => {
    const res = await preflight([
      "--login-path", fakeBin(["bun"]),
      "--env-file", envFile(GOOD_ENV),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/neither claude nor codex/);
  });

  it("only warns when one runner of two is missing", async () => {
    const res = await preflight([
      "--login-path", fakeBin(["claude", "bun"]),
      "--env-file", envFile(GOOD_ENV),
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/WARN.*codex is missing/s);
    expect(res.out).toContain("Preflight passed");
  });

  /**
   * Measured on devbox-vps 2026-09-05. `codex` was on the login PATH and preflight said
   * ok; the binary behind it was a JS CLI whose shebang is `#!/usr/bin/env node`, and node
   * lives inside a mise shim the service never sees. Every spawn died with
   * "app-server closed its output" — a healthy-looking host that could not start an agent,
   * which is the exact failure this check exists to prevent, one layer deeper.
   *
   * Locating a runner is not evidence it runs. So the check runs it.
   */
  it("refuses a runner that resolves but cannot execute", async () => {
    const bin = fakeBin(["claude", "bun"]);
    brokenBin(bin, "codex");

    const res = await preflight(["--login-path", bin, "--env-file", envFile(GOOD_ENV)]);

    expect(res.out).toMatch(/codex/);
    expect(res.out).toMatch(/node|could not run|cannot run/i);
  });

  it("is fatal when the ONLY runner is one that cannot execute", async () => {
    const bin = fakeBin(["bun"]);
    brokenBin(bin, "claude");

    const res = await preflight(["--login-path", bin, "--env-file", envFile(GOOD_ENV)]);

    expect(res.code).toBe(1);
    expect(res.out).toMatch(/neither claude nor codex/);
  });

  it("refuses a façade bound to every interface (ADR-C)", async () => {
    const res = await preflight([
      "--login-path", full,
      "--env-file", envFile({ ...GOOD_ENV, LOTUS_MOBILE_BIND: "0.0.0.0:8787" }),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/every interface/);
  });

  it("refuses a client-mode env file", async () => {
    const res = await preflight([
      "--login-path", full,
      "--env-file", envFile({ ...GOOD_ENV, LOTUS_MODE: "client" }),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/not 'standalone'/);
  });

  it("refuses an FCM path it cannot read, because the config claims push works", async () => {
    const res = await preflight([
      "--login-path", full,
      "--env-file", envFile({ ...GOOD_ENV, LOTUS_FCM_SERVICE_ACCOUNT: "/nope/absent.json" }),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/cannot read/);
  });

  it("accepts a readable FCM path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lotus-fcm-"));
    const path = join(dir, "fcm.json");
    writeFileSync(path, "{}");
    const res = await preflight([
      "--login-path", full,
      "--env-file", envFile({ ...GOOD_ENV, LOTUS_FCM_SERVICE_ACCOUNT: path }),
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/FCM service account readable/);
  });

  it("warns rather than fails when push is simply not configured", async () => {
    const res = await preflight(["--login-path", full, "--env-file", envFile(GOOD_ENV)]);
    expect(res.out).toMatch(/cannot wake a backgrounded phone/);
    expect(res.code).toBe(0);
  });

  it("refuses when there is no env file at all", async () => {
    const res = await preflight(["--login-path", full, "--env-file", "/nope/lotus-host.env"]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/no env file/);
  });

  it("refuses when there is neither a compiled host nor bun", async () => {
    const res = await preflight([
      "--login-path", fakeBin(["claude"]),
      "--env-file", envFile(GOOD_ENV),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/no compiled host given and no bun/);
  });

  it("finds a build in the dist dir without being told its path", async () => {
    const dist = mkdtempSync(join(tmpdir(), "lotus-dist-full-"));
    writeFileSync(join(dist, "lotus-remote-bin"), "");
    const res = await preflightWithDist(dist, [
      "--login-path", fakeBin(["claude"]),
      "--env-file", envFile(GOOD_ENV),
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/runtime: compiled binary/);
  });

  it("prefers a compiled binary over bun when one is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lotus-bin-arg-"));
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "lotus-remote-bin");
    writeFileSync(bin, "");
    const res = await preflight([
      "--login-path", fakeBin(["claude"]),
      "--env-file", envFile(GOOD_ENV),
      "--binary", bin,
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/runtime: compiled binary/);
  });

  /**
   * Measured on devbox-vps 2026-09-05, and the reason `--print-unit` exists: the installed
   * unit ran with systemd's default PATH, which holds neither `~/.local/bin/claude` nor
   * `~/.bun/bin/codex`. Preflight passed — it probes the LOGIN PATH — and the host it
   * installed could not see a single runner. Exactly the "healthy host that can do nothing"
   * the runner check claims to prevent, arrived at through the back door.
   */
  it("gives the unit the same PATH the runner check was made against", async () => {
    const bin = fakeBin(["claude", "codex", "bun"]);
    const res = await preflight([
      "--login-path", bin,
      "--env-file", envFile(GOOD_ENV),
      "--print-unit",
    ]);

    expect(res.code).toBe(0);
    expect(res.out).toContain(`Environment=PATH=${bin}`);
    expect(res.out).not.toContain("__RUN_PATH__");
  });

  it("renders a unit with no placeholder left in it", async () => {
    const res = await preflight([
      "--login-path", fakeBin(["claude", "bun"]),
      "--env-file", envFile(GOOD_ENV),
      "--print-unit",
    ]);

    expect(res.out).toMatch(/^\[Unit\]/m);
    expect(res.out).not.toMatch(/__[A-Z_]+__/);
  });

  it("reports every problem in one run, not the first one", async () => {
    const res = await preflight([
      "--login-path", fakeBin(["bun"]),
      "--env-file", envFile({ ...GOOD_ENV, LOTUS_MODE: "client" }),
    ]);
    expect(res.out).toMatch(/neither claude nor codex/);
    expect(res.out).toMatch(/not 'standalone'/);
  });
});
