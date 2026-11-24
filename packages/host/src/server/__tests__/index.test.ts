import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createStandaloneHost, type StandaloneHostHandle } from "../index.js";

function resolveLotusRemotePath(relativePath: string): string {
  const rootCandidate = join(process.cwd(), "lotus-remote", relativePath);
  return existsSync(rootCandidate) ? rootCandidate : join(process.cwd(), relativePath);
}

describe("createStandaloneHost", () => {
  let host: StandaloneHostHandle | undefined;

  beforeEach(() => {
    process.env.LOTUS_SKILLS_SEED_DIR = resolveLotusRemotePath("src/skills");
    process.env.LOTUS_MCP_SIDECAR_PATH = resolveLotusRemotePath("mcp/lotus-mcp-server.mjs");
  });

  afterEach(async () => {
    delete process.env.LOTUS_SKILLS_SEED_DIR;
    delete process.env.LOTUS_MCP_SIDECAR_PATH;
    if (host) {
      await host.stop();
      host = undefined;
    }
  });

  it("returns a reachable URL on 127.0.0.1", async () => {
    host = await createStandaloneHost();
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${host.url}/health`);
    expect(res.status).toBe(200);
  });

  it("GET /health returns HealthResponse shape without auth", async () => {
    host = await createStandaloneHost();
    const res = await fetch(`${host.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: unknown; port: unknown; version: unknown };
    expect(body.ok).toBe(true);
    expect(typeof body.port).toBe("number");
    expect(typeof body.version).toBe("string");
  });

  it("GET /health port matches the listening port", async () => {
    host = await createStandaloneHost();
    const portFromUrl = Number(new URL(host.url).port);
    const res = await fetch(`${host.url}/health`);
    const body = (await res.json()) as { port: number };
    expect(body.port).toBe(portFromUrl);
  });

  it("GET /api/sessions returns 401 without Authorization header", async () => {
    host = await createStandaloneHost();
    const res = await fetch(`${host.url}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it("GET /api/sessions returns 401 for wrong token", async () => {
    host = await createStandaloneHost();
    const res = await fetch(`${host.url}/api/sessions`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/sessions returns 200 [] with valid bearer", async () => {
    host = await createStandaloneHost();
    const res = await fetch(`${host.url}/api/sessions`, {
      headers: { Authorization: `Bearer ${host.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it("unknown route returns 404", async () => {
    host = await createStandaloneHost();
    const res = await fetch(`${host.url}/no-such-route`);
    expect(res.status).toBe(404);
  });

  it("stop() closes the server so subsequent requests fail", async () => {
    host = await createStandaloneHost();
    const url = host.url;
    await host.stop();
    host = undefined;
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it("exposes apiKey on the handle", async () => {
    host = await createStandaloneHost();
    expect(typeof host.apiKey).toBe("string");
    expect(host.apiKey.length).toBeGreaterThan(0);
  });

  it("each call generates a different apiKey", async () => {
    const a = await createStandaloneHost();
    const b = await createStandaloneHost();
    expect(a.apiKey).not.toBe(b.apiKey);
    await a.stop();
    await b.stop();
    host = undefined;
  });
});
