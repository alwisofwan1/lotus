"use client";

import { memo, useContext, useEffect, useState, type CSSProperties } from "react";
import { Bot, Check, ChevronRight, FilePlus, FileText, Globe, Lightbulb, Pencil, Search, Terminal, Trash2, Wrench, X } from "lucide-react";

import { itemDestroys } from "../../domain/destructive";
import { splitHandoff } from "../../domain/handoff";
import { splitPicks } from "../../domain/preview";
import { splitQuotes } from "../../domain/quotes";
import { decisionRecord, requestTitle } from "../../domain/requests";
import { itemRun } from "../../domain/runs";
import type { ThreadItem } from "../../domain/thread-event";
import type { InteractionState } from "../../domain/thread-state";
import { gapDuration, sameTimelineRow, subAgent, toolParts, type TimelineRow, type WorkStatus, type WorkStep } from "../../domain/timeline";
import { AttachmentChip, ImageGallery } from "../ChatAttachments";
import { BubbleQuotes } from "../ChatQuotes";
import { Dither } from "../Dither";
import { FileLink, ReplyFiles, ReviewLink } from "../ChatFiles";
import { AGENT_NAMES } from "../ChatModel";
import { PickChip } from "../ChatPreview";
import { KawungMark, kawungFadeUrl } from "../Kawung";
import { RunChip } from "../ChatRuns";
import { ForkMarker, MessageEditor, TurnActionsContext, TurnFoot, UserFoot } from "../ChatTurnActions";
import { ChatMarkdown } from "./ChatMarkdown";

interface TimelineRowViewProps {
  row: TimelineRow;
  /** The user's own open/closed choice for a work row; undefined = follow the row's state. */
  expanded: boolean | undefined;
  onToggle: (rowId: string, open: boolean) => void;
  /** The last row while the turn still runs: a reply keeps its caret after its text is done. */
  pending?: boolean;
}

// Done speaks through the mark and the summary; the others need words.
const STATUS_LABEL: Record<WorkStatus, string | null> = {
  running: "Working…",
  needsApproval: "Waiting for you",
  completed: null,
  failed: "Failed",
  interrupted: "Stopped",
};

/** Your message: the bubble, and on hover its time, Copy and Edit; Edit turns it into an input in place. */
function UserRow({ row }: { row: Extract<TimelineRow, { kind: "user" }> }) {
  const actions = useContext(TurnActionsContext);
  const [editing, setEditing] = useState(false);
  const { handoff, text: typed } = splitHandoff(row.text);
  const { picks, text: picked } = splitPicks(typed);
  const { quotes, text } = splitQuotes(picked);
  const images = row.attachments.filter((a) => a.kind === "image");
  const files = row.attachments.filter((a) => a.kind !== "image");
  // Only the typed words are edited; a handoff, picks and quotes before them go again as they were.
  const before = row.text.endsWith(text) ? row.text.slice(0, row.text.length - text.length) : "";
  const edit = actions?.edit;
  return (
    // "sent:" = shown before its echo (ChatPage); it rises out of the composer.
    <div className="chat-row chat-row--user" data-sent={row.id.startsWith("sent:") ? "" : undefined} data-editing={editing || undefined}>
      {handoff && (
        <details className="chat-handoff">
          <summary>Continued from a {AGENT_NAMES[handoff.from as keyof typeof AGENT_NAMES] ?? handoff.from} chat</summary>
          <p>{handoff.context}</p>
        </details>
      )}
      <ImageGallery images={images} />
      {files.length > 0 && (
        <ul className="chat-attachments chat-row-attachments" aria-label="Attached">
          {files.map((attachment) => (
            <AttachmentChip key={attachment.path} attachment={attachment} />
          ))}
        </ul>
      )}
      {picks.length > 0 && (
        <div className="chat-row-picks" aria-label="Picked on the page">
          {picks.map((p, i) => (
            <PickChip key={i} pick={p} />
          ))}
        </div>
      )}
      {editing && edit ? (
        <MessageEditor initial={text} onCancel={() => setEditing(false)} onSend={(next) => edit(row.turnId, `${before}${next}`)} />
      ) : (
        (text || quotes.length > 0) && (
          <div className="chat-bubble">
            <BubbleQuotes quotes={quotes} />
            {text}
          </div>
        )
      )}
      {!editing && row.at !== undefined && <UserFoot text={text} at={row.at} edit={row.edit} first={row.first} onEdit={() => setEditing(true)} />}
    </div>
  );
}

function TimelineRowViewImpl({ row, expanded, onToggle, pending = false }: TimelineRowViewProps) {
  switch (row.kind) {
    case "user":
      return <UserRow row={row} />;
    case "assistant":
      return (
        <div className="chat-row chat-row--assistant">
          <ChatMarkdown text={row.text} streaming={row.streaming || pending} />
          {row.filesSince !== undefined && <ReplyFiles text={row.text} since={row.filesSince} endedAt={row.turnEnd?.endedAt} />}
          {row.turnEnd && row.turnId && <TurnFoot text={row.text} turnId={row.turnId} end={row.turnEnd} />}
        </div>
      );
    case "work":
      return <WorkCard row={row} expanded={expanded} onToggle={onToggle} />;
    case "approval":
      return (
        <div className="chat-row">
          <RequestRecord interaction={row.interaction} />
        </div>
      );
    case "notice":
      return (
        <div className="chat-row chat-notice" data-tone={row.tone} role={row.tone === "error" ? "alert" : undefined}>
          {row.text}
        </div>
      );
    case "gap":
      return <GapDivider at={row.at} afterMs={row.afterMs} />;
    case "fork":
      return <ForkMarker fromThreadId={row.fromThreadId} fromTitle={row.fromTitle} turn={row.turn} worktree={row.worktree} canMove={row.canMove} />;
  }
}

export const TimelineRowView = memo(
  TimelineRowViewImpl,
  (a, b) =>
    sameTimelineRow(a.row, b.row) && a.expanded === b.expanded && a.onToggle === b.onToggle && a.pending === b.pending,
);

// P1 "Dither horizon": two dotted wings, thickest beside the label and thinning to the edges.
const wingIn = (u: number) => 0.04 + 0.34 * u * u;
const wingOut = (u: number) => 0.04 + 0.34 * (1 - u) * (1 - u);
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "14:05 · 17 hours later" within a day; past that the date, "Mon, 27 Oct · 09:12". */
function GapDivider({ at, afterMs }: { at: number; afterMs: number }) {
  const when = new Date(at);
  return (
    <div className="chat-row chat-gap" role="separator">
      <Dither className="chat-gap-wing" field={wingIn} gap />
      <time dateTime={when.toISOString()}>
        {afterMs < 86_400_000 ? (
          <>
            <span className="chat-gap-clock">{CLOCK.format(when)}</span> · {gapDuration(afterMs)} later
          </>
        ) : (
          <>
            {DAY.format(when)} · <span className="chat-gap-clock">{CLOCK.format(when)}</span>
          </>
        )}
      </time>
      <Dither className="chat-gap-wing" field={wingOut} gap />
    </div>
  );
}

/** While live, only the newest steps show; the rest fold into one "+N earlier steps" line. */
const LIVE_STEPS = 4;

// A thought the model hid (empty text) is never a step; while live it is the header's "Thinking".
const isHiddenThought = (step: WorkStep) => step.item.kind === "reasoning" && step.item.text.trim() === "";

function WorkCard({ row, expanded, onToggle }: { row: Extract<TimelineRow, { kind: "work" }> } & Pick<TimelineRowViewProps, "expanded" | "onToggle">) {
  const [all, setAll] = useState(false);
  // A live run stays open until it ends, then folds once; the user's own choice wins either way.
  // A step that waits for the user is never hidden behind a closed row.
  const live = row.status === "running" || row.status === "needsApproval";
  const open = row.status === "needsApproval" || (expanded ?? live);
  const steps = row.steps.filter((s) => !isHiddenThought(s));
  const current = row.steps.findLast((s) => s.item.status === "running") ?? row.steps.at(-1);
  const earlier = live && !all ? Math.max(0, steps.length - LIVE_STEPS) : 0;
  // Live, the header says what is happening now; done, what was done.
  const now = !current || current.item.kind === "reasoning" ? "Thinking" : current.title;
  const destroys = steps.some((s) => itemDestroys(s.item));
  // One ring breathes out from the danger mark when a run that deleted ends while watched; a row
  // remounted by scrolling (virtualized) or loaded from history stays still.
  const [ring, setRing] = useState(false);
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live && destroys) setRing(true);
  }
  return (
    <div className="chat-row chat-work" data-status={row.status} data-destroys={destroys || undefined}>
      <button type="button" className="chat-work-head" aria-expanded={open} onClick={() => onToggle(row.id, !open)}>
        <span className="chat-work-mark" aria-hidden data-ring={ring || undefined} onAnimationEnd={(event) => event.animationName === "chat-work-ring" && setRing(false)}>
          {live ? (
            <KawungMark live className="chat-work-kawung" />
          ) : destroys ? (
            <Trash2 size={10} strokeWidth={2.4} />
          ) : row.status === "completed" ? (
            <Check size={11} strokeWidth={2.5} />
          ) : (
            <X size={11} strokeWidth={2.5} />
          )}
        </span>
        <span className="chat-work-summary">
          {row.status === "needsApproval" ? STATUS_LABEL.needsApproval : live ? <StepTitle text={now} /> : row.summary}
        </span>
        {!live && STATUS_LABEL[row.status] && <span className="chat-work-status">{STATUS_LABEL[row.status]}</span>}
        {destroys && !live && <span className="chat-work-deletes" title="A step here deletes or force-overwrites">· deletes</span>}
        <span className="chat-work-time">
          {steps.length > 1 && `${steps.length} steps · `}
          {row.endedAt !== null ? seconds(row.endedAt - row.startedAt) : <Elapsed since={row.startedAt} />}
        </span>
        <ChevronRight className="chat-work-chevron" size={12} aria-hidden />
      </button>
      {steps.length > 0 && (
        // Stays mounted, so folding animates its height and the steps do not replay their entrance.
        <div className="chat-work-body" data-open={open || undefined} inert={!open}>
          <div>
            <ol className="chat-work-steps">
              {earlier > 0 && (
                <li>
                  <button type="button" className="chat-work-earlier" onClick={() => setAll(true)}>
                    +{earlier} earlier {earlier === 1 ? "step" : "steps"}
                  </button>
                </li>
              )}
              {steps.slice(earlier).map((step) => (
                <StepLine key={step.item.id} step={step} />
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

function StepLine({ step }: { step: WorkStep }) {
  const { item } = step;
  const [open, setOpen] = useState(false);
  const running = item.status === "running";
  const title =
    item.kind === "reasoning" && !running && step.endedAt !== null
      ? `Thought for ${seconds(step.endedAt - step.startedAt)}`
      : step.title;
  // A sub-agent's reply (or its whole report, on the Agent step) opens like a command's output.
  const detail =
    item.kind === "reasoning" || item.kind === "agentMessage"
      ? item.text.trim()
      : item.kind === "command" || subAgent(item)
        ? ("output" in item ? (item.output ?? "") : "").trimEnd()
        : "";
  // A finished thought or command opens to its text; a running one shows its newest lines.
  const foldable = !running && detail !== "";
  const label = <StepTitle text={title} source={item.kind === "tool" ? toolParts(item.name).source : null} />;
  return (
    <li
      className="chat-step"
      data-kind={stepKind(item)}
      data-status={item.status}
      data-open={open || undefined}
      data-nested={step.depth > 0 || undefined}
      data-destroys={itemDestroys(item) || undefined}
      style={step.depth > 0 ? ({ "--chat-step-depth": step.depth } as CSSProperties) : undefined}
    >
      <span className="chat-step-icon" aria-hidden>
        <StepIcon item={item} />
      </span>
      <div className="chat-step-row">
        {item.kind === "fileRead" || item.kind === "fileChange" ? (
          <FileLink text={item.path} fallback={label}>
            {label}
          </FileLink>
        ) : foldable ? (
          <button type="button" className="chat-step-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {label}
          </button>
        ) : (
          label
        )}
        {item.status !== "completed" && !running && !itemRun(item) && <span className="chat-step-status">{item.status}</span>}
        <RunChip item={item} />
        {item.kind === "fileChange" && !running && <ReviewLink path={item.path} />}
        {!running && <StepMeta step={step} />}
      </div>
      {/* While it waits, the card header and the composer say so; the step keeps only the decision. */}
      {step.interaction?.resolution && <RequestRecord interaction={step.interaction} />}
      {detail && (running || open) && (
        item.kind === "reasoning" ? (
          <div className="chat-step-trace" style={running ? { "--chat-trace-fade": kawungFadeUrl() } as CSSProperties : undefined}>
            {running ? <span>{detail}</span> : detail}
          </div>
        ) : (
          <pre className="chat-step-out">{detail.split("\n").slice(running ? -4 : -40).join("\n")}</pre>
        )
      )}
    </li>
  );
}

const ICONS = { think: Lightbulb, read: FileText, search: Search, cmd: Terminal, edit: Pencil, create: FilePlus, web: Globe, tool: Wrench, agent: Bot, reply: Bot };

function stepKind(item: ThreadItem): keyof typeof ICONS {
  switch (item.kind) {
    case "reasoning":
      return "think";
    case "fileRead":
      return "read";
    case "search":
      return "search";
    case "command":
      return "cmd";
    case "fileChange":
      return item.change === "create" ? "create" : "edit";
    case "tool":
      return subAgent(item) ? "agent" : /^web/i.test(item.name) ? "web" : "tool";
    case "agentMessage":
      return "reply";
    default:
      return "tool";
  }
}

function StepIcon({ item }: { item: ThreadItem }) {
  const Icon = itemDestroys(item) ? Trash2 : ICONS[stepKind(item)];
  return <Icon size={11} strokeWidth={1.75} />;
}

// "Read src/a.ts": the verb quiet, the object bright; an MCP tool's server after it, quieter still.
function StepTitle({ text, source = null }: { text: string; source?: string | null }) {
  const m = /^(Searched for|\S+) ([\s\S]+)$/.exec(text);
  if (!m || /^Thought for/.test(text)) return <span className="chat-step-title">{text}</span>;
  return (
    <span className="chat-step-title">
      {m[1]} <b data-mono={m[1] === "Ran" || undefined}>{m[2]}</b>
      {source && <span className="chat-step-src"> · {source}</span>}
    </span>
  );
}

function StepMeta({ step }: { step: WorkStep }) {
  const { item } = step;
  if (item.kind === "fileRead" && item.lineCount !== null) return <span className="chat-step-meta">{`${item.lineCount} lines`}</span>;
  if (item.kind === "fileChange" && item.patch) {
    let add = 0;
    let del = 0;
    for (const hunk of item.patch) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) add++;
        else if (line.startsWith("-")) del++;
      }
    }
    return (
      <span className="chat-step-meta">
        <span className="chat-step-add">+{add}</span> <span className="chat-step-del">−{del}</span>
      </span>
    );
  }
  if (item.kind === "command" && step.endedAt !== null) return <span className="chat-step-meta">{seconds(step.endedAt - step.startedAt)}</span>;
  return null;
}

/** Seconds since `since`, ticking once a second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{seconds(Math.max(0, now - since))}</>;
}

// The request itself waits in the composer; the timeline points at it, then keeps the decision.
function RequestRecord({ interaction }: { interaction: InteractionState }) {
  const { resolution } = interaction;
  return (
    <span className="chat-request-record" data-decision={resolution?.decision ?? "waiting"}>
      {resolution
        ? decisionRecord(interaction.interaction, resolution)
        : `Waiting for you · ${requestTitle(interaction.interaction)}`}
    </span>
  );
}

function seconds(ms: number): string {
  return ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`;
}
