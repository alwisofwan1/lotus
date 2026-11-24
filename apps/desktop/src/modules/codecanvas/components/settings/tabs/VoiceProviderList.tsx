"use client";
import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { SettingSwitch } from "@/modules/lotus-settings/components/SettingSwitch";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";

/** Structural subset shared by TTS and STT provider configs (extra keys like voice/model/language allowed). */
export interface VoiceProviderRow {
  id: string;
  name: string;
  kind: string;
  builtin: boolean;
  enabled: boolean;
  apiKey?: string;
  [key: string]: unknown;
}

interface Props {
  /** Names the radio group for screen readers. */
  heading: string;
  loading: boolean;
  error: Error | null;
  providers: VoiceProviderRow[];
  active: string;
  onSave: (provider: VoiceProviderRow) => Promise<void>;
  onSetActive: (id: string) => Promise<void>;
  /** Optional per-provider config (e.g. TTS "voice", STT "language"). */
  extraField?: {
    key: string;
    label: string;
    placeholder: string;
    /** When this returns a non-empty list for a row, render a dropdown of those values (plus a
     *  "Default" option, and the current value if it's custom) instead of a free-text field. */
    options?: (row: VoiceProviderRow) => readonly string[] | undefined;
  };
}

/**
 * Reusable provider list for the Voice settings tab — renders a BYOK provider registry (STT or TTS):
 * per provider an active radio, enabled toggle, API key (password, redaction-aware), and an optional
 * free-text field. Cloud synthesis/transcription is implemented in Rust (`tts_providers.rs` /
 * `stt_providers.rs`); keys stay in Rust and come back redacted.
 */
export function VoiceProviderList({ heading, loading, error, providers, active, onSave, onSetActive, extraField }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Partial<VoiceProviderRow>>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [revealKey, setRevealKey] = useState<Record<string, boolean>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    setDrafts({}); // reset drafts to freshly-loaded values
  }, [providers]);

  const draftFor = (p: VoiceProviderRow): VoiceProviderRow => ({ ...p, ...drafts[p.id] });
  const setDraft = (id: string, patch: Partial<VoiceProviderRow>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  // A key is configured (the redaction sentinel "***" counts — the real key lives in Rust).
  const hasUsableKey = (row: VoiceProviderRow) => typeof row.apiKey === "string" && row.apiKey.length > 0;

  async function persist(p: VoiceProviderRow, patch: Partial<VoiceProviderRow>) {
    setSavingId(p.id);
    try {
      const next = { ...draftFor(p), ...patch };
      await onSave(next);
      // The unreliable browser default shouldn't strand a freshly-configured cloud provider: once this
      // one is usable (cloud + enabled + keyed) and only the default is active, promote it so the mic
      // just works without a separate "Set active" click.
      if (next.kind !== "browser" && next.enabled && hasUsableKey(next) && active === "browser") {
        await onSetActive(p.id);
      }
    } finally {
      setSavingId(null);
    }
  }

  async function makeActive(id: string) {
    setSavingId(id);
    try {
      await onSetActive(id);
    } finally {
      setSavingId(null);
    }
  }

  const fieldLabel = "ds-t-meta font-medium text-(--ui-ink-3)";
  return (
    <div role="radiogroup" aria-label={heading} className="flex flex-col">
      {error ? (
        <p className="m-0 px-3.5 py-2.5 ds-t-meta text-(--ui-err)">Failed to load providers: {error.message}</p>
      ) : loading ? (
        <p className="m-0 px-3.5 py-2.5 ds-t-meta text-(--ui-ink-3)">Loading providers…</p>
      ) : (
        providers.map((p, i) => {
          const d = draftFor(p);
          const isActive = p.id === active;
          const disabled = savingId === p.id;
          const isCloud = p.kind !== "browser";
          const expanded = Boolean(open[p.id]);
          const extraVal = extraField ? (typeof d[extraField.key] === "string" ? (d[extraField.key] as string) : "") : "";
          const extraOptions = extraField?.options?.(d) ?? undefined;
          // Preserve a custom/stored value not in the curated list so it stays selectable.
          const selectOptions =
            extraOptions && extraVal && !extraOptions.includes(extraVal) ? [extraVal, ...extraOptions] : extraOptions;
          const meta = !isCloud ? "built-in, no key" : !hasUsableKey(p) ? "needs a key" : p.enabled ? "key saved" : "key saved · off";
          return (
            <div key={p.id} className={i > 0 ? "border-t border-(--ui-line)" : undefined} data-active={isActive ? "true" : undefined}>
              <div className="ui-row">
                <button
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => void makeActive(p.id)}
                  disabled={disabled}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:opacity-60"
                >
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full"
                    style={{ boxShadow: isActive ? "inset 0 0 0 4px var(--ui-accent)" : "inset 0 0 0 1.5px var(--ui-line-strong)" }}
                    aria-hidden="true"
                  />
                  <span className="truncate ds-t-body text-(--ui-ink)">{p.name}</span>
                  <span className="truncate ds-t-meta text-(--ui-ink-3)">{meta}</span>
                </button>
                {isCloud && (
                  <Button size="sm" aria-expanded={expanded} onClick={() => setOpen((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}>
                    {expanded ? "Done" : hasUsableKey(p) ? "Edit" : "Add key"}
                  </Button>
                )}
              </div>

              {isCloud && expanded && (
                <div className="flex flex-col gap-3 px-3.5 pb-3.5 pl-10">
                  <label className="flex cursor-pointer items-center justify-between gap-3">
                    <span className="ds-t-meta text-(--ui-ink)">
                      Enabled <span className="text-(--ui-ink-3)">· selectable as the active provider</span>
                    </span>
                    <SettingSwitch
                      checked={d.enabled}
                      disabled={disabled}
                      onChange={() => void persist(p, { enabled: !d.enabled })}
                      label={`Enable ${p.name}`}
                    />
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <span className={fieldLabel}>API key</span>
                    <div className="flex items-center gap-2">
                      <Input
                        mono
                        type={revealKey[p.id] ? "text" : "password"}
                        value={drafts[p.id]?.apiKey ?? (p.apiKey === "***" ? "" : (p.apiKey ?? ""))}
                        disabled={disabled}
                        placeholder={p.apiKey === "***" ? "•••• stored — type to replace" : "Paste your API key"}
                        onChange={(e) => setDraft(p.id, { apiKey: e.target.value })}
                        onBlur={() => {
                          if (drafts[p.id]?.apiKey !== undefined) void persist(p, {});
                        }}
                        className="min-w-0 flex-1"
                      />
                      <Button
                        variant="ghost"
                        icon
                        aria-label={revealKey[p.id] ? "Hide key" : "Show key"}
                        onClick={() => setRevealKey((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                      >
                        {revealKey[p.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </Button>
                    </div>
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <span className={fieldLabel}>Model</span>
                    <Input
                      mono
                      value={typeof d.model === "string" ? d.model : ""}
                      disabled={disabled}
                      placeholder="e.g. gpt-transcribe"
                      onChange={(e) => setDraft(p.id, { model: e.target.value })}
                      onBlur={() => {
                        if (drafts[p.id]?.model !== undefined) void persist(p, {});
                      }}
                    />
                  </label>

                  {extraField && (
                    <div className="flex flex-col gap-1.5">
                      <span className={fieldLabel}>{extraField.label}</span>
                      {selectOptions && selectOptions.length > 0 ? (
                        <Select
                          label={extraField.label}
                          value={extraVal}
                          disabled={disabled}
                          options={[{ value: "", label: "Default" }, ...selectOptions.map((v) => ({ value: v, label: v }))]}
                          onChange={(v) => {
                            setDraft(p.id, { [extraField.key]: v });
                            void persist(p, { [extraField.key]: v });
                          }}
                          className="self-start"
                        />
                      ) : (
                        <Input
                          aria-label={extraField.label}
                          value={extraVal}
                          disabled={disabled}
                          placeholder={extraField.placeholder}
                          onChange={(e) => setDraft(p.id, { [extraField.key]: e.target.value })}
                          onBlur={() => {
                            if (drafts[p.id]?.[extraField.key] !== undefined) void persist(p, {});
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
