import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMcpIpcDiscovery, removeMcpIpcDiscovery } from "../mcp-ipc-discovery.js";

describe("mcp-ipc-discovery", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-disc-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes { port, secret } as JSON, creating parent dirs", () => {
    const path = join(dir, "nested", "lotus-mcp-ipc.json");
    writeMcpIpcDiscovery(path, { port: 47823, secret: "s3cr3t" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ port: 47823, secret: "s3cr3t" });
  });

  it("writes the file 0600 (it carries the Bearer secret)", () => {
    const path = join(dir, "lotus-mcp-ipc.json");
    writeMcpIpcDiscovery(path, { port: 1, secret: "x" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("removes the file and tolerates a missing file", () => {
    const path = join(dir, "lotus-mcp-ipc.json");
    writeMcpIpcDiscovery(path, { port: 1, secret: "x" });
    removeMcpIpcDiscovery(path);
    expect(existsSync(path)).toBe(false);
    expect(() => removeMcpIpcDiscovery(path)).not.toThrow();
  });
});
