import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

import type { Router } from "../../server/router.js";

/** Loopback only. The whole point of a second listener is that it is unroutable. */
const ADMIN_HOST = "127.0.0.1";

export interface AdminServerOptions {
  router: Router;
  /** Rust-generated shared secret. Empty means the host was not spawned by Lotus. */
  secret: string;
  /** Discovery file Rust reads to learn the OS-assigned port. */
  advertPath: string;
}

/**
 * Serves the admin router on loopback and advertises its port for Rust.
 * The child binds port 0 and reports back: a port picked before spawn can be taken first.
 */
export class AdminServer {
  private server: Server | null = null;

  constructor(private readonly opts: AdminServerOptions) {}

  /** Rejects rather than starting unauthenticated; see the secret check inside. */
  async start(): Promise<void> {
    if (this.opts.secret.trim().length === 0) {
      // An unauthenticated listener is a control channel for every local
      // process. Running without an admin surface is strictly better.
      throw new Error("admin secret is required; refusing to start an unauthenticated channel");
    }

    const server = createServer((req, res) => {
      if (this.opts.router.dispatch(req, res)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, ADMIN_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.writeAdvert();
  }

  /** Bound address once started, or null before `start`. */
  address(): { host: string; port: number } | null {
    const addr = this.server?.address();
    return addr !== null && typeof addr === "object"
      ? { host: (addr as AddressInfo).address, port: (addr as AddressInfo).port }
      : null;
  }

  async stop(): Promise<void> {
    await this.stopWithoutCleanup();
    rmSync(this.opts.advertPath, { force: true });
  }

  /** Closes the socket but leaves the advert, so tests can imitate a crash. */
  async stopWithoutCleanup(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private writeAdvert(): void {
    const port = this.address()?.port;
    if (port === undefined) return;
    mkdirSync(dirname(this.opts.advertPath), { recursive: true });
    // `mode` on writeFileSync only applies when creating the file, so a stale
    // advert from a previous run would keep its old permissions. Remove first.
    rmSync(this.opts.advertPath, { force: true });
    writeFileSync(
      this.opts.advertPath,
      JSON.stringify({ port, pid: process.pid, host: ADMIN_HOST }, null, 2),
      { mode: 0o600 },
    );
  }
}
