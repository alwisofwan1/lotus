"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Zap, ShieldCheck, History, Trash2 } from "lucide-react";
import { useRunnerRegistry } from "@/lib/hooks/useRunnerRegistry";
import { saveRunnerConfig, deleteRunnerConfig, type RunnerInfo } from "@/lib/tauri-api";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import { resumeCapability } from "../../../services/session-resume-capability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

/** One runner setting: leading glyph + label (+ muted hint), switch pinned right. */
function RunnerToggleRow({
  icon,
  label,
  hint,
  switchLabel,
  checked,
  disabled,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  switchLabel: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="flex min-w-0 items-center gap-2 ds-t-meta text-(--ui-ink)">
        {icon}
        <span className="font-medium">{label}</span>
        {hint ? <span className="truncate text-(--ui-ink-3)">· {hint}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onChange={onToggle} label={switchLabel} />
    </div>
  );
}

/**
 * Per-runner launch settings (ADR-0027 Phase 3) over the Runner Registry (`~/.lotus/runners.json`
 * via `useRunnerRegistry` + `saveRunnerConfig`). Rendered inside each expanded CLI row of
 * Settings › Agents (`AgentClisSection`).
 */
export function useRunnerSettings() {
  const { registry, loading, error, refresh } = useRunnerRegistry();
  // Local draft of the extra-flags input per runner — committed to the registry on blur so we
  // don't write a file on every keystroke.
  const [flagDrafts, setFlagDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const runners = registry?.runners ?? [];

  // Seed drafts whenever the registry reloads (keeps inputs in sync after refresh).
  useEffect(() => {
    if (!registry) return;
    setFlagDrafts((prev) => {
      const next = { ...prev };
      for (const r of registry.runners) {
        if (!(r.id in next)) next[r.id] = r.extra_flags;
      }
      return next;
    });
  }, [registry]);

  async function persist(
    r: RunnerInfo,
    patch: {
      skip_permissions?: boolean;
      extra_flags?: string;
      resume_on_reopen?: boolean;
      claude_family?: boolean;
      resume_template?: string;
    },
  ) {
    setSavingId(r.id);
    try {
      await saveRunnerConfig(r.id, {
        id: r.id,
        skip_permissions: patch.skip_permissions ?? r.skip_permissions,
        extra_flags: patch.extra_flags ?? r.extra_flags,
        resume_on_reopen: patch.resume_on_reopen ?? r.resume_on_reopen,
        resume_session_id: r.resume_session_id,
        // Preserve the identity of a custom runner across edits — otherwise saving a toggle would drop
        // its command/name and orphan the runner.
        ...(r.custom ? { custom: true, name: r.name, command: r.command } : {}),
        claude_family: patch.claude_family ?? r.claude_family,
        resume_template: patch.resume_template ?? r.resume_template,
        new_session_template: r.new_session_template,
      });
      // Signal consumers (runner cache, NL bar) that the registry changed — a config save alters
      // the launch command (skip-permissions/extra-flags), so cached reads must go stale here too.
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("lotus:runners-changed"));
      await refresh();
    } finally {
      setSavingId(null);
    }
  }

  /** `{id}` templates a custom runner declared, edited like the extra-flags field beside them. */
  const [resumeDrafts, setResumeDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!registry) return;
    setResumeDrafts((prev) => {
      const next = { ...prev };
      for (const r of registry.runners) {
        if (!(r.id in next)) next[r.id] = r.resume_template ?? "";
      }
      return next;
    });
  }, [registry]);

  const commitResumeTemplate = (r: RunnerInfo) => {
    const draft = (resumeDrafts[r.id] ?? "").trim();
    if (draft === (r.resume_template ?? "").trim()) return;
    void persist(r, { resume_template: draft });
  };

  const commitFlags = (r: RunnerInfo) => {
    const draft = flagDrafts[r.id] ?? "";
    if (draft.trim() === r.extra_flags.trim()) return;
    void persist(r, { extra_flags: draft.trim() });
  };

  // Delete removes a custom runner entirely (it exists only as config). For a detected CLI it would
  // just reset config to defaults — but the UI only exposes delete on custom runners.
  const removeCustom = async (r: RunnerInfo) => {
    setSavingId(r.id);
    try {
      await deleteRunnerConfig(r.id);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("lotus:runners-changed"));
      await refresh();
    } finally {
      setSavingId(null);
    }
  };

  return {
    registry, runners, loading, error, refresh, savingId,
    flagDrafts, setFlagDrafts, resumeDrafts, setResumeDrafts,
    persist, commitFlags, commitResumeTemplate, removeCustom,
  };
}

export type RunnerSettings = ReturnType<typeof useRunnerSettings>;

/** The settings of one installed runner: the body of an expanded CLI row. */
export function RunnerSettingsRows({ r, cfg }: { r: RunnerInfo; cfg: RunnerSettings }) {
  const { persist, savingId, flagDrafts, setFlagDrafts, resumeDrafts, setResumeDrafts, commitFlags, commitResumeTemplate, removeCustom } = cfg;
  const disabled = !r.installed || savingId === r.id;
  return (
    <div className="flex flex-col gap-1 rounded-(--ui-r-md) bg-(--ui-fill) px-3 py-2">
    {/* Skip-permissions / YOLO toggle — hidden for custom runners (their command is
        launched verbatim, so YOLO is whatever the user baked into it). */}
    {!r.custom && (
      <RunnerToggleRow
        icon={
          r.skip_permissions ? (
            <Zap className="h-3.5 w-3.5 shrink-0 text-(--ui-warn)" aria-hidden="true" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-(--ui-ink-3)" aria-hidden="true" />
          )
        }
        label="Skip permissions"
        hint="YOLO mode, no per-tool prompts"
        switchLabel={`Skip permissions for ${r.name}`}
        checked={r.skip_permissions}
        disabled={disabled}
        onToggle={() => void persist(r, { skip_permissions: !r.skip_permissions })}
      />
    )}

    {/* "This runner is Claude Code" — only for custom runners (a 2nd-account / profile
        wrapper like `ccs <profile>`). Grants full claude-family treatment so the agent
        can collaborate with teammates (peer messaging), take --model, and resume. */}
    {r.custom && (
      <RunnerToggleRow
        icon={<Zap className="h-3.5 w-3.5 shrink-0 text-(--ui-ink)" aria-hidden="true" />}
        label="This runner is Claude Code"
        hint="enables teammates, model & resume"
        switchLabel={`Treat ${r.name} as Claude Code`}
        checked={r.claude_family ?? false}
        disabled={disabled}
        onToggle={() => void persist(r, { claude_family: !r.claude_family })}
      />
    )}

    {/* How a CUSTOM runner continues a conversation. Built-ins are described by the
        kernel's own table; `custom` covers grok, opencode and second-account Claude
        alike, so the method has to travel with the entry (Session Widget, Slice 06).
        `resume_on_reopen` below is the permission — this is what it acts on. */}
    {r.custom && !r.claude_family && (
      <div className="mt-1.5 flex items-center gap-2.5">
        <span className="w-24 shrink-0 ds-t-meta font-medium text-(--ui-ink)">Resume flag</span>
        <Input
          mono
          value={resumeDrafts[r.id] ?? ""}
          disabled={disabled}
          placeholder="e.g. --resume {id}"
          aria-label={`Resume flag template for ${r.name}`}
          onChange={(e) => setResumeDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
          onBlur={() => commitResumeTemplate(r)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="flex-1"
        />
      </div>
    )}

    {/* Resume-on-reopen — only for runners that can actually continue a conversation. */}
    {resumeCapability(r.id as AgentRunnerType, r).kind !== "unsupported" && (
      <RunnerToggleRow
        icon={<History className="h-3.5 w-3.5 shrink-0 text-(--ui-ink-3)" aria-hidden="true" />}
        label="Resume conversation on reopen"
        switchLabel={`Resume conversation on reopen for ${r.name}`}
        checked={r.resume_on_reopen}
        disabled={disabled}
        onToggle={() => void persist(r, { resume_on_reopen: !r.resume_on_reopen })}
      />
    )}

    {/* Extra flags — a compact inline field so a runner card stays short and scannable. */}
    <div className="mt-1.5 flex items-center gap-2.5">
      <span className="w-24 shrink-0 ds-t-meta font-medium text-(--ui-ink)">Extra flags</span>
      <Input
        mono
        aria-label={`Extra flags for ${r.name}`}
        value={flagDrafts[r.id] ?? ""}
        disabled={disabled}
        placeholder="e.g. --model opus"
        onChange={(e) => setFlagDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
        onBlur={() => commitFlags(r)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="flex-1"
      />
    </div>
      {r.custom && (
        <Button
          variant="danger"
          size="sm"
          className="mt-1.5 self-start"
          aria-label={`Delete custom runner ${r.name}`}
          disabled={savingId === r.id}
          onClick={() => void removeCustom(r)}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
        </Button>
      )}
    </div>
  );
}
