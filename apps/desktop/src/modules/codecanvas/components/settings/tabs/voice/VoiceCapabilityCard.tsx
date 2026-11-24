"use client";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Status, type StatusTone } from "@/components/ui/status";
import type { VoiceStatus, VoiceTone } from "./voice-health";

const STATUS_TONE: Record<VoiceTone, StatusTone> = { ok: "ok", warn: "warn", err: "err", off: "neutral", busy: "neutral" };

interface Props {
  title: string;
  /** Muted suffix after the title, e.g. "optional". */
  note?: string;
  status: VoiceStatus;
  /** Active engine; shown before the status in the row's subtext. Empty hides it. */
  engine: string;
  /** Replaces the status word while things are fine, e.g. "tested 2 min ago". */
  hint?: string;
  /** The one fix shown under a problem (frame 06). */
  fix?: ReactNode;
  /** Extra line under the subtext, e.g. a running test. */
  children?: ReactNode;
  actions?: ReactNode;
  /** The engine settings, shown under the row while open. */
  panel?: ReactNode;
  open: boolean;
  onToggle: () => void;
}

/**
 * One Voice engine (Listen / Speak / Live) as a kit row: what it is, the engine doing it and a
 * status from real checks, Test, and a chevron that opens its settings right under the row. A
 * problem says what and why with exactly one fix, in place.
 */
export function VoiceCapabilityCard({ title, note, status, engine, hint, fix, children, actions, panel, open, onToggle }: Props) {
  const problem = status.problem && status.what;
  const word = status.tone === "ok" && hint ? hint : status.label;
  const body = Boolean(children || problem || (open && panel));
  return (
    <section aria-label={`${title} — ${status.label}`} className="ui-row-item">
      <div className="ui-row">
        <button type="button" onClick={onToggle} aria-expanded={open} className="ui-row-text text-left">
          <span className="ui-row-label">
            {title}
            {note && <span className="font-normal text-(--ui-ink-4)">{note}</span>}
          </span>
          <span className="ui-row-desc flex min-w-0 items-center gap-1.5" data-tone={status.tone}>
            {engine && <span className="truncate">{engine}</span>}
            <Status tone={STATUS_TONE[status.tone]} busy={status.tone === "busy"}>
              {word}
            </Status>
          </span>
        </button>
        <div className="ui-row-ctl">
          {actions}
          <Button variant="ghost" size="sm" icon onClick={onToggle} aria-label={`${open ? "Hide" : "Show"} ${title} settings`}>
            <ChevronRight size={14} className="ui-chevron" style={open ? { transform: "rotate(90deg)" } : undefined} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {body ? (
        <div className="ui-row-body flex flex-col gap-3">
          {children}
          {problem && (
            <div role="alert" className="flex flex-col items-start gap-2 rounded-(--ui-r-md) bg-(--ui-fill) px-3 py-2.5">
              <span className="ds-t-meta text-(--ui-ink-3)">
                {status.what !== status.label && <><b className="font-medium text-(--ui-ink)">{status.what}</b>. </>}
                {status.why}
              </span>
              {fix}
            </div>
          )}
          {open && panel && <div className="ui-group-card">{panel}</div>}
        </div>
      ) : null}
    </section>
  );
}

/** Row button on the kit Button: `primary` is the solid accent fill. */
export function CardButton({ primary, children, ...rest }: { primary?: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button variant={primary ? "primary" : "secondary"} size="sm" {...rest}>
      {children}
    </Button>
  );
}

/** "Needs a key" / "Fix key": the key field inside a card's problem box. */
export function VoiceKeyFix({ engine, onSave }: { engine: string; onSave: (key: string) => Promise<void> }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(key.trim());
      setKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="flex w-full flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <span className="flex items-center gap-2">
        <Input
          mono
          type="password"
          aria-label={`${engine} API key`}
          placeholder="Paste API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="primary" size="sm" disabled={saving || !key.trim()}>
          {saving ? "Saving…" : "Save and test"}
        </Button>
      </span>
      {error && <span className="ds-t-micro text-(--ui-err)">{error}</span>}
    </form>
  );
}
