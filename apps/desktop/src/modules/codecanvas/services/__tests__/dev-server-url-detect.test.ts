import { describe, expect, it } from "vitest";
import { detectDevServerUrl } from "../dev-server-url-detect";

const ESC = String.fromCharCode(27);

describe("detectDevServerUrl", () => {
  it("detects a Vite 'Local:' ready line", () => {
    expect(detectDevServerUrl("  ➜  Local:   http://localhost:5173/")).toEqual({
      url: "http://localhost:5173/",
    });
  });

  it("detects a Next.js dev 'Local' line", () => {
    const out = "  ▲ Next.js 15.0.0\n  - Local:        http://localhost:3000\n";
    expect(detectDevServerUrl(out)).toEqual({ url: "http://localhost:3000" });
  });

  it("detects a CRA/webpack line and the loopback host", () => {
    const out = "Compiled successfully!\n\n  Local:            http://localhost:8080/\n";
    expect(detectDevServerUrl(out)).toEqual({ url: "http://localhost:8080/" });
  });

  it("handles ANSI-colored Vite output where the port is a separate color run", () => {
    // Vite bolds the port: http://localhost:<bold>5173<reset>/
    const line = `${ESC}[32m  ➜  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`;
    expect(detectDevServerUrl(line)).toEqual({ url: "http://localhost:5173/" });
  });

  it("normalizes 0.0.0.0 to localhost", () => {
    expect(detectDevServerUrl("Server listening on http://0.0.0.0:4000")).toEqual({
      url: "http://localhost:4000",
    });
  });

  it("accepts 127.0.0.1 with a readiness signal", () => {
    expect(detectDevServerUrl("Server running at http://127.0.0.1:8000/")).toEqual({
      url: "http://127.0.0.1:8000/",
    });
  });

  it("returns null for a loopback URL with NO readiness signal (prose / curl noise)", () => {
    expect(detectDevServerUrl("curl http://localhost:3000/api/health")).toBeNull();
    expect(detectDevServerUrl("see http://localhost:3000 for details")).toBeNull();
  });

  it("returns null for a non-loopback URL even with a readiness word", () => {
    expect(detectDevServerUrl("deploy ready at https://example.com")).toBeNull();
  });

  it("returns null for empty / signal-only output", () => {
    expect(detectDevServerUrl("")).toBeNull();
    expect(detectDevServerUrl("server is ready")).toBeNull();
  });

  it("does not strip literal brackets from ordinary text (ANSI matcher needs ESC)", () => {
    // A snapshot ax-tree line contains [ref=e1]; it must not be mangled, and with no
    // loopback URL present it simply yields null.
    expect(detectDevServerUrl('- link "Learn more" [ref=e1]')).toBeNull();
  });
});
