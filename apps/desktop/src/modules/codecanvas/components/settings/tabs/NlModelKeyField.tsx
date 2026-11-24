"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";
import { getNlModelConfig, setNlModelConfig, type NlModelConfig } from "@/lib/tauri-api";

/**
 * BYOK model for the NL command bar (W1c). When set, NL utility calls (parse / dispatch refine /
 * dictation polish) go over a direct HTTP call (~sub-second). Without it, non-local commands may use
 * the slower CLI; latency-sensitive dictation polish fails open to the original transcript instead.
 * Provider-agnostic:
 * bring an OpenAI, Anthropic, or Gemini key. Stored in Rust (`~/.lotus/nl-model.json`); the key only
 * travels renderer→Rust on save (reads come back redacted).
 */
const PROVIDERS = [
  { id: "openai", label: "OpenAI", placeholder: "sk-...", modelHint: "gpt-4o-mini (default)" },
  { id: "anthropic", label: "Anthropic", placeholder: "sk-ant-...", modelHint: "claude-haiku-4-5 (default)" },
  { id: "gemini", label: "Gemini", placeholder: "AIza...", modelHint: "gemini-2.5-flash (default)" },
] as const;

export function NlModelKeyField() {
  const [config, setConfig] = useState<NlModelConfig | null>(null);
  const [provider, setProvider] = useState<string>("openai");
  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const cfg = await getNlModelConfig();
    setConfig(cfg);
    if (cfg.provider) setProvider(cfg.provider);
    setModelDraft(cfg.model ?? "");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!config) return null;

  const keyIsSet = config.apiKey === "***" && config.provider === provider;
  const active = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

  const save = async (opts: { clear?: boolean } = {}) => {
    setSaving(true);
    setJustSaved(false);
    setError(null);
    try {
      const apiKey = opts.clear ? "" : keyDraft.trim() ? keyDraft.trim() : "***"; // "***" keeps the stored key
      await setNlModelConfig({ provider, apiKey, model: modelDraft.trim() || undefined });
      setKeyDraft("");
      await load();
      if (!opts.clear) setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup
      title="Command model"
      footer={
        error ? (
          <span className="text-(--ui-err)" role="alert">
            Failed to save NL model config: {error}
          </span>
        ) : keyIsSet || justSaved ? (
          `${active.label} key set — NL calls use direct HTTP.`
        ) : undefined
      }
    >
      <SettingRow
        label="Provider key"
        description="Optional. Speeds up canvas commands; without it, dictation cleanup falls back to the original transcript."
        body={
          <div className="flex items-center gap-2">
            <Input
              mono
              type="password"
              value={keyDraft}
              disabled={saving}
              placeholder={keyIsSet ? "•••••••• (key set — type to replace)" : active.placeholder}
              aria-label={`${active.label} API key`}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && keyDraft.trim()) void save();
              }}
              className="flex-1"
            />
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || (!keyDraft.trim() && !keyIsSet)}>
              Save
            </Button>
            {keyIsSet && (
              <Button variant="ghost" size="sm" onClick={() => void save({ clear: true })} disabled={saving}>
                Clear
              </Button>
            )}
          </div>
        }
      >
        <SegmentedControl
          label="NL model provider"
          options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
          value={provider}
          onChange={(id) => {
            setProvider(id);
            setModelDraft(config.provider === id ? config.model ?? "" : "");
          }}
        />
      </SettingRow>
      <SettingRow label="Model" description="Optional override.">
        <Input
          mono
          value={modelDraft}
          disabled={saving}
          placeholder={active.modelHint}
          aria-label="NL model id"
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={() => {
            if (keyIsSet) void save(); // persist a model change when a key is already stored
          }}
          className="w-56"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
