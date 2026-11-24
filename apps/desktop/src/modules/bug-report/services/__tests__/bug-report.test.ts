import { describe, expect, it } from "vitest";
import { buildIssueUrl, MAX_URL_LENGTH, redactHome, reportMarkdown, type BugReport } from "../bug-report";

const context = { version: "0.13.0", os: "macOS 27.0", arch: "aarch64", release: true, crash: null, log: "a\nb\nc" };
const report = (over: Partial<BugReport> = {}): BugReport => ({ summary: "Pane went blank\nafter split", context, diagnostics: true, ...over });
const params = (url: string) => new URL(url).searchParams;

describe("buildIssueUrl", () => {
  it("prefills the issue form fields", () => {
    const p = params(buildIssueUrl(report()));
    expect(p.get("template")).toBe("bug.yml");
    expect(p.get("title")).toBe("Pane went blank");
    expect(p.get("summary")).toBe("Pane went blank\nafter split");
    expect(p.get("environment")).toBe("Lotus 0.13.0 · macOS 27.0 (aarch64) · release");
    expect(p.get("logs")).toBe("── sessiond.log ──\na\nb\nc");
  });

  it("sends only the user's words when diagnostics are off", () => {
    const p = params(buildIssueUrl(report({ diagnostics: false })));
    expect(p.has("environment")).toBe(false);
    expect(p.has("logs")).toBe(false);
  });

  it("drops the oldest log lines first and keeps the crash and the newest lines", () => {
    const log = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const crash = { atMs: Date.UTC(2026, 10, 18, 21, 4), text: "panicked at src/pty.rs:212" };
    const url = buildIssueUrl(report({ context: { ...context, log, crash } }));
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    const logs = params(url).get("logs")!;
    expect(logs).toContain("── crash 2026-11-18 21:04 ──\npanicked at src/pty.rs:212");
    expect(logs).toContain("── sessiond.log ──");
    expect(logs).toContain("line 1999");
    expect(logs).not.toContain("line 0 ");
  });

  it("cuts a huge summary only as a last resort", () => {
    const url = buildIssueUrl(report({ summary: "y".repeat(20_000), diagnostics: false }));
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
  });

  it("puts the view error first, without the home folder", () => {
    const viewError = { message: "Cannot read /Users/alice/x.json", digest: "3f9a1c07" };
    const logs = params(buildIssueUrl(report({ viewError }))).get("logs")!;
    expect(logs.startsWith("── view error (3f9a1c07) ──\nCannot read ~/x.json")).toBe(true);
  });
});

describe("reportMarkdown", () => {
  it("fences the logs", () => {
    expect(reportMarkdown(report())).toContain("## Logs\n\n```\n── sessiond.log ──\na\nb\nc\n```");
  });
});

describe("redactHome", () => {
  it("hides the user name in home paths", () => {
    expect(redactHome("/home/bob/a and /Users/alice/b")).toBe("~/a and ~/b");
  });
});
