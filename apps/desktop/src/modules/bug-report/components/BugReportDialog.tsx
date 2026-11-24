"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Toast } from "@/components/ui/toast";
import { copyTextToClipboard } from "@/lib/clipboard";
import { openExternalLink } from "@/lib/tauri-api";
import {
  buildIssueUrl,
  diagnosticsPreview,
  loadBugReportContext,
  markCrashSeen,
  reportMarkdown,
  type BugReport,
  type BugReportContext,
  type ViewError,
} from "../services/bug-report";

const TOAST_MS = 10_000;

function clock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Report a bug (mockups/bug-report.html): one field, diagnostics the user can review, then a
 * prefilled public issue in the browser. Renders the dialog while `open`, then the "Opened in
 * GitHub" toast with a copy fallback; mount it once where the trigger lives.
 */
export function BugReportDialog({
  open,
  onClose,
  viewError,
}: {
  open: boolean;
  onClose: () => void;
  /** Set by an error screen: the render error goes first in the logs. */
  viewError?: ViewError | null;
}) {
  const [context, setContext] = useState<BugReportContext | null>(null);
  const [summary, setSummary] = useState("");
  const [diagnostics, setDiagnostics] = useState(true);
  const [review, setReview] = useState(false);
  const [sent, setSent] = useState<{ report: BugReport; copied: boolean } | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadBugReportContext()
      .then((next) => {
        if (cancelled) return;
        setContext(next);
        // Seen once the dialog shows it: the rail dot goes away, the crash stays in this report.
        if (next.crash) void markCrashSeen().catch(() => {});
      })
      .catch((error) => console.warn("[bug-report] context failed:", error));
    fieldRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [sent]);

  const report: BugReport | null = context ? { summary, context, diagnostics, viewError } : null;
  const ready = report !== null && summary.trim().length > 0;

  const send = () => {
    if (!report || !ready) return;
    void openExternalLink(buildIssueUrl(report)).catch((error) => console.warn("[bug-report] open failed:", error));
    setSent({ report, copied: false });
    setSummary("");
    setReview(false);
    onClose();
  };

  const copy = () => {
    if (!sent) return;
    void copyTextToClipboard(reportMarkdown(sent.report)).then(() => setSent({ ...sent, copied: true }));
  };

  const banner = viewError
    ? { title: `This view failed to render${viewError.digest ? ` (${viewError.digest})` : ""}.`, detail: "The error is attached below." }
    : context?.crash
      ? { title: `Lotus hit an internal error at ${clock(context.crash.atMs)}.`, detail: "The crash log is attached below." }
      : null;

  return (
    <>
      {open ? (
        <Dialog
          title="Report a bug"
          description="Tell us what went wrong. Lotus fills in the rest."
          onClose={onClose}
          className="max-w-[440px]"
          footer={
            <>
              <span
                className="mr-auto flex items-center gap-1.5 text-[12px] text-(--ui-ink-4)"
                title="You review the issue on GitHub before it is posted."
              >
                <Globe size={12} strokeWidth={1.75} aria-hidden />
                Posted publicly on GitHub
              </span>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={!ready} onClick={send}>
                Open in GitHub
                <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden />
              </Button>
            </>
          }
        >
          {banner ? (
            <div className="mt-4 flex gap-2.5 rounded-(--ui-r-md) bg-[color-mix(in_oklab,var(--ui-err)_9%,transparent)] px-3 py-2.5">
              <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-(--ui-err)" aria-hidden />
              <span className="min-w-0">
                {banner.title}
                <span className="block text-[12px] text-(--ui-ink-3)">{banner.detail}</span>
              </span>
            </div>
          ) : null}

          <Textarea
            ref={fieldRef}
            filled
            rows={5}
            aria-label="What happened"
            placeholder="What happened, and what did you expect?"
            className="mt-4 w-full"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
          />

          <div className="mt-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Include diagnostics</p>
              <p className="text-[12px] text-(--ui-ink-4)">
                Version, OS and recent logs, private details removed.{" "}
                {diagnostics && report ? (
                  <button
                    type="button"
                    className="text-(--ui-ink-3) underline decoration-(--ui-line-strong) underline-offset-2 hover:text-(--ui-ink)"
                    aria-expanded={review}
                    onClick={() => setReview((v) => !v)}
                  >
                    {review ? "Hide" : "Review"}
                  </button>
                ) : null}
              </p>
            </div>
            <Switch label="Include diagnostics" checked={diagnostics} onChange={setDiagnostics} />
          </div>
          {review && diagnostics && report ? (
            <pre className="mt-2.5 mb-0 max-h-[160px] overflow-auto rounded-(--ui-r-md) bg-(--ui-fill) px-3 py-2.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap text-(--ui-ink-3)">
              {diagnosticsPreview(report)}
            </pre>
          ) : null}
        </Dialog>
      ) : null}

      {sent ? (
        <Toast
          title="Opened in GitHub"
          detail={
            sent.copied ? (
              "Report copied"
            ) : (
              <button type="button" className="underline hover:text-(--ui-ink)" onClick={copy}>
                Copy report instead
              </button>
            )
          }
        />
      ) : null}
    </>
  );
}
