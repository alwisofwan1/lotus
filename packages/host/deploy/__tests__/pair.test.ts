import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const PAIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pair.sh");
const SECRET = "s3cret";

interface Result { code: number; out: string }

/**
 * `pair.sh` against a stand-in admin server: the real one needs a running host, and
 * what is under test is the script's reading of the env file, the advert and the replies.
 */
describe("pair.sh", () => {
  let dir: string;
  let server: Server;
  let mobile: { host: string; port: number } | null;
  let minted: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lotus-pair-"));
    mobile = { host: "100.64.0.10", port: 8787 };
    minted = 0;
    server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (req.method === "GET" && req.url === "/admin/health") {
        res.writeHead(200).end(JSON.stringify({ ok: true, hostId: "vps", mobile, deviceCount: 0 }));
        return;
      }
      if (req.method === "POST" && req.url === "/admin/pairing-code") {
        minted += 1;
        res.writeHead(200).end(JSON.stringify({ code: "75447516", expiresAt: Date.now() + 300_000 }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    writeFileSync(join(dir, "mobile-admin.json"), JSON.stringify({ port, pid: 1, host: "127.0.0.1" }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  function env(lines: string[]): string {
    const path = join(dir, "lotus-host.env");
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  async function pair(args: string[]): Promise<Result> {
    try {
      const { stdout, stderr } = await run("bash", [PAIR, "--state-dir", dir, "--no-qr", ...args]);
      return { code: 0, out: stdout + stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  }

  it("mints a code and prints the same invite the desktop QR carries", async () => {
    const r = await pair(["--env-file", env([`LOTUS_MOBILE_ADMIN_SECRET=${SECRET}`])]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("lotus-pair://invite?v=1&address=100.64.0.10%3A8787&code=75447516");
    expect(r.out).toMatch(/code\s+75447516/);
    expect(minted).toBe(1);
  });

  it("puts an explicit tunnel address in the invite instead of the bound one", async () => {
    const r = await pair([
      "--env-file", env([`LOTUS_MOBILE_ADMIN_SECRET=${SECRET}`]),
      "--address", "https://pocket.example.com",
    ]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("address=https%3A%2F%2Fpocket.example.com&code=75447516");
  });

  it("reads LOTUS_PAIR_ADDRESS from the env file", async () => {
    const r = await pair(["--env-file", env([
      `LOTUS_MOBILE_ADMIN_SECRET=${SECRET}`,
      "LOTUS_PAIR_ADDRESS=https://pocket.example.com",
    ])]);

    expect(r.out).toContain("address=https%3A%2F%2Fpocket.example.com");
  });

  it("refuses to put a loopback bind in the QR, and mints nothing", async () => {
    mobile = { host: "127.0.0.1", port: 8787 };

    const r = await pair(["--env-file", env([`LOTUS_MOBILE_ADMIN_SECRET=${SECRET}`])]);

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--address");
    expect(minted).toBe(0);
  });

  it("refuses without an admin secret, naming the consequence", async () => {
    const r = await pair(["--env-file", env(["LOTUS_MODE=standalone"])]);

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no admin surface");
  });

  it("says the secret is wrong when the host refuses it", async () => {
    const r = await pair([
      "--env-file", env(["LOTUS_MOBILE_ADMIN_SECRET=wrong"]),
      "--address", "100.64.0.10:8787",
    ]);

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("LOTUS_MOBILE_ADMIN_SECRET");
  });

  it("says the host is not running when there is no advert", async () => {
    rmSync(join(dir, "mobile-admin.json"));

    const r = await pair(["--env-file", env([`LOTUS_MOBILE_ADMIN_SECRET=${SECRET}`])]);

    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no admin advert");
  });
});
