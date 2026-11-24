"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import type { ModelEntry, ProviderConfig, ProviderType } from "@/lib/model-registry-types";
import { fetchApiModels } from "@/modules/chat/runtime/chat-runtime-client";

// ─── Provider type options ────────────────────────────────────────────────────

const PROVIDER_TYPES: { value: ProviderType; label: string; desc: string; needsUrl: boolean }[] = [
  { value: "claude-cli",    label: "Claude CLI",     desc: "Anthropic claude binary",  needsUrl: false },
  { value: "codex-cli",     label: "Codex CLI",      desc: "OpenAI codex binary",      needsUrl: false },
  { value: "qwen-cli",      label: "Qwen CLI",       desc: "qwen-code binary + API",   needsUrl: true  },
  { value: "openai-compat", label: "OpenAI Compat",  desc: "Any OpenAI-compatible API", needsUrl: true  },
];

// OpenAI-compatible endpoints a Chat can talk to (#288, mockup "06e API providers"). A preset only
// fills the form; the base URLs are the providers' documented /v1 roots.
const PRESETS: { id: string; name: string; vendor: string; baseUrl: string }[] = [
  { id: "deepseek", name: "DeepSeek", vendor: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { id: "sumopod", name: "Sumopod", vendor: "Sumopod", baseUrl: "https://ai.sumopod.com/v1" },
  { id: "openrouter", name: "OpenRouter", vendor: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ollama", name: "Ollama", vendor: "Local", baseUrl: "http://localhost:11434/v1" },
];

// ─── Editable tag input for model IDs ────────────────────────────────────────

interface ModelTagInputProps {
  models: ModelEntry[];
  onChange: (models: ModelEntry[]) => void;
}

function ModelTagInput({ models, onChange }: ModelTagInputProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addModel = (raw: string) => {
    const id = raw.trim();
    if (!id || models.some((m) => m.id === id)) return;
    onChange([...models, { id, label: id }]);
    setDraft("");
  };

  const removeModel = (id: string) => {
    onChange(models.filter((m) => m.id !== id));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addModel(draft);
    } else if (e.key === "Backspace" && !draft && models.length > 0) {
      removeModel(models[models.length - 1].id);
    }
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className="ui-field flex h-auto min-h-(--ui-h-md) cursor-text flex-wrap items-center gap-1.5 py-1.5 focus-within:shadow-[inset_0_0_0_1px_var(--ui-accent)]"
    >
      {models.map((m) => (
        <span
          key={m.id}
          className="inline-flex items-center gap-1 rounded-(--ui-r-sm) bg-(--ui-fill) px-2 py-0.5 font-mono ds-t-meta text-(--ui-ink)"
        >
          {m.id}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeModel(m.id); }}
            aria-label={`Remove ${m.id}`}
            className="text-(--ui-ink-4) transition-colors hover:text-(--ui-err)"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (draft.trim()) addModel(draft); }}
        placeholder={models.length === 0 ? "Paste model ID from dashboard, press Enter…" : "Add model…"}
        className="min-w-[140px] flex-1 bg-transparent font-mono ds-t-meta text-(--ui-ink) outline-none placeholder:font-sans placeholder:text-(--ui-ink-4)"
      />
    </div>
  );
}

// ─── Text input primitive ─────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="ds-t-meta font-medium text-(--ui-ink-2)">{label}</label>
      {children}
      {hint && <p className="m-0 ds-t-meta text-(--ui-ink-3)">{hint}</p>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  monospace,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  monospace?: boolean;
  type?: "text" | "password" | "url";
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="ui-field w-full"
      data-mono={monospace ? "" : undefined}
    />
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

const EMPTY_PROVIDER: ProviderConfig = {
  id: "",
  name: "",
  vendor: "",
  type: "qwen-cli",
  builtin: false,
  enabled: true,
  baseUrl: "",
  apiKey: "",
  defaultModel: "",
  models: [],
};

interface Props {
  open: boolean;
  provider: ProviderConfig | null;
  onClose: () => void;
  onSave: (provider: ProviderConfig) => Promise<void>;
  /** Chat's API providers: always OpenAI-compatible, so no Type, Vendor or ID to fill. */
  apiOnly?: boolean;
  /** In place inside a page (Settings is already a modal), not a dialog over it. */
  inline?: boolean;
}

export function ProviderFormModal({ open, provider, onClose, onSave, apiOnly = false, inline = false }: Props) {
  const isEdit = provider !== null;
  // Initialized via lazy function — component is remounted (via key prop in parent)
  // each time the modal opens, so this runs fresh every time.
  const [form, setForm] = useState<ProviderConfig>(() =>
    provider ? { ...provider } : { ...EMPTY_PROVIDER, id: crypto.randomUUID(), ...(apiOnly && { type: "openai-compat" as const }) },
  );
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const fetchModels = async () => {
    if (!form.baseUrl?.trim()) return setError("Base URL is required to fetch models");
    setFetching(true);
    setError(null);
    try {
      const ids = await fetchApiModels(form.baseUrl, form.apiKey || null, isEdit ? form.id : null);
      if (ids.length === 0) return setError("The provider listed no models; add them by hand.");
      const known = new Map(form.models.map((m) => [m.id, m]));
      const models = ids.map((id) => known.get(id) ?? { id, label: id });
      patch({ models, defaultModel: ids.includes(form.defaultModel) ? form.defaultModel : ids[0] });
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setFetching(false);
    }
  };

  // Close on Escape
  useEffect(() => {
    if (!open || inline) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, inline, onClose]);

  const patch = (partial: Partial<ProviderConfig>) => {
    setForm((prev) => ({ ...prev, ...partial }));
  };

  const selectedType = PROVIDER_TYPES.find((t) => t.value === form.type);
  const needsUrl = selectedType?.needsUrl ?? false;

  const validate = (): string | null => {
    if (!form.name.trim()) return "Name is required";
    if (!form.id.trim()) return "ID is required";
    if (needsUrl && !form.baseUrl?.trim()) return "Base URL is required for this provider type";
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
      setSaving(false);
    }
  };

  if (!open) return null;

  const title = isEdit ? `Edit ${provider.name}` : apiOnly ? "Add an API provider" : "Add Provider";
  const form_ = (
        <form onSubmit={handleSubmit} className={cn("flex flex-col gap-4", inline ? "pt-1" : "p-5")}>
          {!isEdit && (
            <Field label="Preset" hint="Fills the form for an OpenAI-compatible provider. Chats with it are text only.">
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <Button
                    key={p.id}
                    size="sm"
                    variant={form.baseUrl === p.baseUrl ? "primary" : "secondary"}
                    aria-pressed={form.baseUrl === p.baseUrl}
                    onClick={() => patch({ ...p, type: "openai-compat" })}
                  >
                    {p.name}
                  </Button>
                ))}
              </div>
            </Field>
          )}

          {/* Provider type selector */}
          {!apiOnly && <Field label="Type">
            <div className="grid grid-cols-2 gap-1.5">
              {PROVIDER_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  disabled={isEdit && provider?.builtin}
                  onClick={() => patch({ type: t.value })}
                  className={cn(
                    "flex flex-col items-start rounded-lg border px-3 py-2.5 text-left",
                    "transition-all",
                    form.type === t.value
                      ? "border-[var(--accent)]/50 bg-[var(--accent)]/8 text-[var(--fg)]"
                      : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--text-muted)]/40 hover:text-[var(--fg)]",
                    (isEdit && provider?.builtin) && "opacity-40 cursor-not-allowed",
                  )}
                >
                  <span className="ds-t-meta font-medium">{t.label}</span>
                  <span className="ds-t-meta opacity-70 mt-0.5">{t.desc}</span>
                </button>
              ))}
            </div>
          </Field>}

          {/* Name + Vendor row */}
          <div className={cn("grid gap-3", !apiOnly && "grid-cols-2")}>
            <Field label="Name">
              <TextInput
                value={form.name}
                onChange={(v) => patch({ name: v })}
                placeholder="Qwen DashScope"
              />
            </Field>
            {!apiOnly && <Field label="Vendor">
              <TextInput
                value={form.vendor}
                onChange={(v) => patch({ vendor: v })}
                placeholder="Alibaba Cloud"
              />
            </Field>}
          </div>

          {/* ID field (shown for new providers) */}
          {!isEdit && !apiOnly && (
            <Field label="ID" hint="Unique identifier. Letters, numbers, hyphens only.">
              <TextInput
                value={form.id}
                onChange={(v) => patch({ id: v.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
                placeholder="qwen-dashscope"
                monospace
              />
            </Field>
          )}

          {/* Base URL (only for types that need it) */}
          {needsUrl && (
            <Field label="Base URL" hint="OpenAI-compatible endpoint URL">
              <TextInput
                value={form.baseUrl ?? ""}
                onChange={(v) => patch({ baseUrl: v })}
                placeholder="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
                type="url"
              />
            </Field>
          )}

          {/* API Key */}
          {needsUrl && (
            <Field label="API Key" hint="Kept in the system keychain, not in a file. Leave it as is to keep the saved key; Ollama needs none.">
              <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-(--ui-ink-4)">
                  <KeyRound className="h-3.5 w-3.5" />
                </div>
                <input
                  type={showKey ? "text" : "password"}
                  value={form.apiKey ?? ""}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  placeholder="sk-••••••••••••••"
                  className="ui-field w-full pr-9 pl-9"
                  data-mono=""
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-(--ui-ink-4) transition-colors hover:text-(--ui-ink)"
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </Field>
          )}

          {/* Models */}
          <Field
            label="Models"
            hint="Paste a model ID from your provider dashboard and press Enter to add it."
          >
            <ModelTagInput
              models={form.models}
              onChange={(models) => patch({ models })}
            />
            {form.type === "openai-compat" && (
              <Button size="sm" className="self-start" onClick={() => void fetchModels()} disabled={fetching}>
                {fetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {fetching ? "Fetching…" : "Fetch models from the provider"}
              </Button>
            )}
          </Field>

          {/* Default model */}
          {form.models.length > 0 && (
            <Field label="Default Model">
              <Select
                label="Default model"
                className="w-full"
                data-mono=""
                value={form.defaultModel ?? ""}
                onChange={(defaultModel) => patch({ defaultModel })}
                options={[{ value: "", label: "— none —" }, ...form.models.map((m) => ({ value: m.id, label: m.id }))]}
              />
            </Field>
          )}

          {/* Error */}
          {error && (
            <p className="m-0 rounded-(--ui-r-md) bg-[color-mix(in_oklab,var(--ui-err)_9%,transparent)] px-3 py-2 ds-t-meta text-(--ui-err)" role="alert">
              {error}
            </p>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add provider"}
            </Button>
          </div>
        </form>
  );

  if (inline) {
    return (
      <div className="flex flex-col gap-2 rounded-(--ui-r-md) bg-(--ui-fill) p-3" role="group" aria-label={title}>
        <span className="ds-t-body font-medium text-(--ui-ink)">{title}</span>
        {form_}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      aria-modal
      role="dialog"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={cn(
          "relative z-10 w-full max-w-lg",
          "rounded-t-2xl sm:rounded-2xl",
          "border border-[var(--border)]",
          "bg-[var(--bg-card)] shadow-2xl",
          "max-h-[90vh] overflow-y-auto",
          "animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="ds-t-lede font-semibold text-[var(--fg)]">
              {title}
            </h2>
            <p className="mt-0.5 ds-t-meta text-[var(--text-muted)]">
              {isEdit
                ? "Update configuration and model list"
                : "Connect a new AI provider to Lotus"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-elevated)] transition-all"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {form_}
      </div>
    </div>
  );
}
