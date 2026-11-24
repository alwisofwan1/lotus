"use client";

import { ChevronRight } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { itemRun, RUN_LABEL, type Run, type RunKind } from "../domain/runs";
import type { ThreadItem } from "../domain/thread-event";
import { FileLink } from "./ChatFiles";

// Mockup: mockups/lotus-chat.fig, page "05c Runs" (#283). The checks the agent ran (tests, lint,
// types, builds) as cards, newest first; a red one opens on its failure and can hand it back.

/** Opens a run's card in the drawer; null outside a chat with a drawer. */
export const RunLinksContext = createContext<((itemId: string) => void) | null>(null);

type Tone = "running" | "passed" | "failed" | "quiet";

function tone(run: { status: Run["status"]; failed: boolean }): Tone {
  return run.status === "running" ? "running" : run.failed ? "failed" : run.status === "completed" ? "passed" : "quiet";
}

/** "Failed" alone says too little in a chip: "Build failed". */
function chipText(kind: RunKind, summary: string): string {
  return summary === "Failed" ? `${RUN_LABEL[kind]} failed` : summary;
}

// A chip appears or changes text as checks run, often right under a pointer already on its way to
// something nearby; a click that soon after was aimed at what was there before, not at the chip.
const SETTLE_MS = 300;
function useSettledClick(text: string, action: () => void): () => void {
  const changedAt = useRef(-Infinity);
  useEffect(() => {
    changedAt.current = performance.now();
  }, [text]);
  return () => {
    if (performance.now() - changedAt.current >= SETTLE_MS) action();
  };
}

/** A step's result chip in the timeline; opens the card. Nothing for a command that is not a check. */
export function RunChip({ item }: { item: ThreadItem }) {
  const open = useContext(RunLinksContext);
  const run = itemRun(item);
  const text = run ? chipText(run.kind, run.summary) : "";
  const click = useSettledClick(text, () => open?.(item.id));
  if (!run || item.status === "running") return null;
  const t = tone({ status: item.status, failed: run.failed });
  if (!open) {
    return (
      <span className="chat-run-chip" data-tone={t}>
        {text}
      </span>
    );
  }
  return (
    <button type="button" className="chat-run-chip" data-tone={t} title={`Open in Runs`} onClick={click}>
      {text}
    </button>
  );
}

/** The newest check, for the bar above the composer. */
export function RunBadge({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const running = run.status === "running";
  // "Built" already says "build"; every other summary needs its kind ("Tests 12 passed").
  const text = running ? `${RUN_LABEL[run.kind]} running…` : run.summary === "Built" ? "Built" : `${RUN_LABEL[run.kind]} ${run.summary}`;
  const click = useSettledClick(text, onOpen);
  // Running, it is a status line: there is no result to open yet, and it changes the most.
  if (running) {
    return (
      <span className="chat-run-chip" data-tone={tone(run)}>
        {text}
      </span>
    );
  }
  return (
    <button type="button" className="chat-run-chip" data-tone={tone(run)} onClick={click} title="Open in Runs">
      {text}
    </button>
  );
}

const FIX_TAIL = 20;

/** What "Ask … to fix" puts in the composer; the user still sends it. */
export function fixPrompt(run: Run): string {
  const where = run.ref ? ` (${run.ref})` : "";
  const first = run.error ? `\nFirst failure: ${run.error}${where}` : "";
  // A failure with no parsed excerpt (a build, an unknown runner) still needs its output, and
  // runners report at the end.
  const out = run.excerpt.length > 0 ? run.excerpt : run.lines.slice(-FIX_TAIL);
  const detail = out.length > 0 ? `\n\n\`\`\`\n${out.join("\n")}\n\`\`\`` : "";
  return `\`${run.command}\` failed: ${run.summary}.${first}${detail}\n\nFix it, then run \`${run.command}\` again.`;
}

interface RunsPaneProps {
  runs: Run[];
  /** A chip was clicked: open and show that card. */
  target: { id: string; n: number } | null;
  agentName: string;
  onFix: (run: Run) => void;
}

export function RunsPane({ runs, target, agentName, onFix }: RunsPaneProps) {
  // The newest failure starts open; a chip's target opens its own card.
  // Only the newest failure starts open. When a new run lands on top, earlier cards fold away and
  // a new failure opens; a chip's target opens its own card, earlier or not.
  const top = runs[0] ? `${runs[0].id}:${runs[0].status}` : "";
  const [open, setOpen] = useState<Set<string>>(() => newestFailure(runs));
  const [seenTop, setSeenTop] = useState(top);
  const [seen, setSeen] = useState(target);
  const list = useRef<HTMLDivElement>(null);
  if (top !== seenTop) {
    setSeenTop(top);
    setOpen((s) => new Set([...runs.filter((r) => !r.superseded && s.has(r.id)).map((r) => r.id), ...newestFailure(runs)]));
  }
  if (target !== seen) {
    setSeen(target);
    if (target && !open.has(target.id)) setOpen((s) => new Set(s).add(target.id));
  }
  useEffect(() => {
    if (target) list.current?.querySelector(`[data-run="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [target]);

  const latest = runs.filter((r) => !r.superseded);
  const earlier = runs.filter((r) => r.superseded);
  const card = (run: Run) => (
    <RunCard
      key={run.id}
      run={run}
      open={open.has(run.id)}
      agentName={agentName}
      onToggle={() =>
        setOpen((s) => {
          const next = new Set(s);
          if (!next.delete(run.id)) next.add(run.id);
          return next;
        })
      }
      onFix={() => onFix(run)}
    />
  );
  return (
    <>
      <p className="chat-changes-sub chat-changes-summary">Tests, builds and lints {agentName} ran in this chat</p>
      <div ref={list} className="chat-changes-list chat-runs">
        {runs.length === 0 && <p className="chat-changes-empty">None yet</p>}
        {latest.map(card)}
        {earlier.length > 0 && <div className="chat-runs-earlier">Earlier</div>}
        {earlier.map(card)}
      </div>
    </>
  );
}

function newestFailure(runs: Run[]): Set<string> {
  const run = runs.find((r) => !r.superseded && r.failed);
  return new Set(run ? [run.id] : []);
}

interface RunCardProps {
  run: Run;
  open: boolean;
  agentName: string;
  onToggle: () => void;
  onFix: () => void;
}

function RunCard({ run, open, agentName, onToggle, onFix }: RunCardProps) {
  const [full, setFull] = useState(false);
  const t = tone(run);
  // A running check has nothing to show yet: its output arrives when it ends.
  const openable = run.status !== "running";
  const shown = open && openable;
  return (
    <section className="chat-run" data-run={run.id} data-tone={t} data-open={shown || undefined} data-earlier={run.superseded || undefined}>
      <button type="button" className="chat-run-head" aria-expanded={shown} disabled={!openable} onClick={onToggle}>
        <span className="chat-run-mark" aria-hidden>
          {t === "passed" ? "✓" : t === "failed" ? "!" : null}
        </span>
        <span className="chat-run-kind">{RUN_LABEL[run.kind]}</span>
        <code className="chat-run-command" title={run.command}>
          {run.command}
        </code>
        <span className="chat-run-summary">{run.summary}</span>
        {run.failed && run.passedLater && <span className="chat-run-note">· passed in the next run</span>}
        <ChevronRight size={13} className="chat-run-chevron" aria-hidden />
      </button>
      {shown && (
        <div className="chat-run-body">
          {run.error && (
            <div className="chat-run-fail">
              <div className="chat-run-fail-head">
                <span className="chat-run-fail-name">{run.error}</span>
                {run.ref && (
                  <FileLink text={run.ref}>
                    <code className="chat-run-ref">{run.ref.split("/").at(-1)}</code>
                  </FileLink>
                )}
              </div>
              {run.excerpt.length > 0 && (
                <div className="chat-run-out">
                  {run.excerpt.map((line, i) => (
                    <div key={i} data-kind={/^\s*(?:-|Expected)/.test(line) ? "del" : /^\s*(?:\+|Received)/.test(line) ? "add" : undefined}>
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="chat-run-row">
            {run.lines.length > 0 ? (
              <button type="button" className="chat-run-more" aria-expanded={full} onClick={() => setFull(!full)}>
                {full ? "Hide output" : `Full output · ${run.lines.length} ${run.lines.length === 1 ? "line" : "lines"}`}
              </button>
            ) : (
              <span className="chat-run-more">No output</span>
            )}
            {run.failed && !run.superseded && (
              <button type="button" className="chat-run-fix" onClick={onFix}>
                Ask {agentName} to fix
              </button>
            )}
          </div>
          {full && <pre className="chat-run-output">{run.lines.join("\n")}</pre>}
        </div>
      )}
    </section>
  );
}
