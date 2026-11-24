"use client";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Hammer } from "lucide-react";
import type { AgentNodeStatus } from "../../types/canvas";
import type { AgentRunEntry, AgentRunView } from "../../services/agent-run-view";
import { ThinkingLoader } from "@/components/ui/thinking-loader";
import { AgentMarkdownBlock } from "./AgentMarkdownBlock";

const isBusy = (s: AgentNodeStatus) => s === "connecting" || s === "running";
const isTool = (e: AgentRunEntry): e is Extract<AgentRunEntry, { kind: "tool" }> => e.kind === "tool";

function ToolChip({ label }: { label: string }) {
  return (
    <div className="agent-transcript-tool" title={label}>
      <span className="agent-transcript-tool-glyph" aria-hidden>
        <Hammer size={9} />
      </span>
      <span className="agent-transcript-tool-label">{label}</span>
    </div>
  );
}

/** Renders a headless run: assistant prose as markdown, tool activity collapsed behind a toggle. */
export const AgentRunTranscript = memo(function AgentRunTranscript({
  view,
  status,
}: {
  view: AgentRunView;
  status: AgentNodeStatus;
}) {
  const [showActivity, setShowActivity] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stick, setStick] = useState(true);

  const { entries } = view;
  const tools = useMemo(() => entries.filter(isTool), [entries]);
  const hasActivity = tools.length > 0;
  const visible = useMemo(
    () => (showActivity ? entries : entries.filter((e) => e.kind === "message")),
    [entries, showActivity],
  );
  const empty = visible.length === 0;
  const busy = isBusy(status);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [view, showActivity, stick]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="agent-transcript nodrag nowheel">
      {hasActivity && (
        <button
          type="button"
          className="agent-transcript-toggle"
          aria-pressed={showActivity}
          aria-label={showActivity ? "Hide tool activity" : "Show tool activity"}
          title={showActivity ? "Hide tool activity" : "Show tool activity"}
          onClick={() => setShowActivity((v) => !v)}
        >
          {showActivity ? <Eye size={11} aria-hidden /> : <EyeOff size={11} aria-hidden />}
        </button>
      )}
      <div className="agent-transcript-scroll" ref={scrollRef} role="log" aria-live="polite">
        {empty && busy ? (
          // Until prose arrives, the newest tool is the only real signal of what the run is doing.
          // Tool entries are append-only with no end event, so this is the tool that most recently
          // started — never a guessed phase — and the count is every tool reported so far.
          <ThinkingLoader
            label={tools.at(-1)?.label ?? "Working"}
            detail={hasActivity ? `${tools.length} ${tools.length === 1 ? "tool" : "tools"}` : undefined}
            className="agent-thinking"
          />
        ) : empty ? (
          <p className="agent-transcript-empty">Ready to run.</p>
        ) : (
          visible.map((entry, i) =>
            entry.kind === "message" ? (
              <AgentMarkdownBlock key={i} text={entry.text} />
            ) : (
              <ToolChip key={i} label={entry.label} />
            ),
          )
        )}
        {busy && !empty && <span className="agent-transcript-cursor" aria-hidden />}
      </div>
    </div>
  );
});
