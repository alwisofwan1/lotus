import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/** Public repo; its issue form (`.github/ISSUE_TEMPLATE/bug.yml`) has the field ids used below. */
export const ISSUES_NEW_URL = "https://github.com/alwisofwan1/lotus/issues/new";
/** GitHub answers 414 above about 8 KB of URL. */
export const MAX_URL_LENGTH = 7_500;
const CRASH_LINES = 25;

/** `bug_report.rs` → `BugReportContext`. Already redacted by Rust. */
export interface BugReportContext {
  version: string;
  os: string;
  arch: string;
  release: boolean;
  crash: { atMs: number; text: string } | null;
  log: string;
}

/** A render error caught by an error boundary. */
export interface ViewError {
  message: string;
  digest?: string;
}

export interface BugReport {
  summary: string;
  context: BugReportContext;
  diagnostics: boolean;
  viewError?: ViewError | null;
}

export function loadBugReportContext(): Promise<BugReportContext> {
  if (!isTauri()) {
    return Promise.resolve({ version: "web", os: "browser", arch: "", release: false, crash: null, log: "" });
  }
  return tauriInvoke<BugReportContext>("bug_report_context");
}

export function markCrashSeen(): Promise<void> {
  return isTauri() ? tauriInvoke("bug_report_mark_crash_seen") : Promise.resolve();
}

/** An error message can quote a path under the user's home folder; the name in it is private. */
export function redactHome(text: string): string {
  return text.replace(/\/(Users|home)\/[^/\s]+/g, "~");
}

export function environmentLine({ version, os, arch, release }: BugReportContext): string {
  return `Lotus ${version} · ${os}${arch ? ` (${arch})` : ""} · ${release ? "release" : "dev"}`;
}

function crashTime(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 16).replace("T", " ");
}

/** The Logs field: render error, crash head, then the daemon log tail (oldest lines first to go). */
function logSections(report: BugReport): { head: string[]; log: string[] } {
  const head: string[] = [];
  if (report.viewError) {
    head.push(`── view error${report.viewError.digest ? ` (${report.viewError.digest})` : ""} ──`, redactHome(report.viewError.message));
  }
  const { crash, log } = report.context;
  if (crash) {
    head.push(`── crash ${crashTime(crash.atMs)} ──`, ...crash.text.split("\n").slice(0, CRASH_LINES));
  }
  const lines = log ? log.split("\n") : [];
  return { head, log: lines.length ? ["── sessiond.log ──", ...lines] : [] };
}

/** What the dialog's Review shows: exactly what the Logs field will carry. */
export function diagnosticsPreview(report: BugReport): string {
  const { head, log } = logSections(report);
  return [environmentLine(report.context), "", ...head, ...log].join("\n");
}

function title(summary: string): string {
  const first = summary.trim().split("\n")[0] ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first || "Bug report";
}

/**
 * The prefilled issue-form URL. Log lines are dropped oldest first until it fits; the user's own
 * words are cut only when nothing else is left to drop.
 */
export function buildIssueUrl(report: BugReport): string {
  const { head, log } = report.diagnostics ? logSections(report) : { head: [], log: [] };
  const build = (summary: string, lines: string[]) => {
    const params = new URLSearchParams({
      template: "bug.yml",
      title: title(report.summary),
      labels: "bug,from-app",
      summary,
    });
    if (report.diagnostics) {
      params.set("environment", environmentLine(report.context));
      params.set("logs", lines.join("\n"));
    }
    return `${ISSUES_NEW_URL}?${params}`;
  };

  const lines = [...head, ...log];
  let url = build(report.summary, lines);
  // The section header stays, so drop from just after it.
  const firstLog = head.length + 1;
  while (url.length > MAX_URL_LENGTH && lines.length > firstLog) {
    lines.splice(firstLog, 1);
    url = build(report.summary, lines);
  }
  while (url.length > MAX_URL_LENGTH && lines.length) {
    lines.pop();
    url = build(report.summary, lines);
  }
  let summary = report.summary;
  while (url.length > MAX_URL_LENGTH && summary.length > 200) {
    summary = `${summary.slice(0, Math.floor(summary.length * 0.8))}…`;
    url = build(summary, lines);
  }
  return url;
}

/** "Copy report instead": the same content as markdown, for when the browser is not signed in. */
export function reportMarkdown(report: BugReport): string {
  const parts = [`## What happened\n\n${report.summary.trim()}`];
  if (report.diagnostics) {
    const { head, log } = logSections(report);
    parts.push(`## Environment\n\n${environmentLine(report.context)}`);
    parts.push(`## Logs\n\n\`\`\`\n${[...head, ...log].join("\n")}\n\`\`\``);
  }
  return parts.join("\n\n");
}
