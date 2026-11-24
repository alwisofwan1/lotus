"use client";

import { useState } from "react";
import { Cpu, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTile, Tag } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/modules/lotus-settings/components/SettingsGroup";
import { ProviderFormModal } from "@/modules/settings/components/ProviderFormModal";
import { useModelRegistry } from "@/modules/settings/hooks/useModelRegistry";
import type { ProviderConfig } from "@/lib/model-registry-types";

const TYPE_LABEL: Record<string, string> = { "openai-compat": "OpenAI Compat", ollama: "Ollama" };

function ProviderRow({
  provider,
  onEdit,
  onDelete,
  onToggle,
}: {
  provider: ProviderConfig;
  onEdit: () => void;
  onDelete?: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const modelCount = provider.models.length;
  return (
    <SettingRow
      leading={
        <IconTile>
          <Cpu size={15} />
        </IconTile>
      }
      label={
        <span className="inline-flex flex-wrap items-center gap-2">
          {provider.name}
          <Tag>{TYPE_LABEL[provider.type] ?? provider.type}</Tag>
        </span>
      }
      description={
        modelCount > 0 ? (
          <>
            {provider.vendor} · {modelCount} model{modelCount !== 1 ? "s" : ""}
            {provider.defaultModel && <span className="font-mono"> · {provider.defaultModel}</span>}
          </>
        ) : (
          `${provider.vendor} · No models configured`
        )
      }
    >
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      {!provider.builtin && onDelete && (
        <Button variant="ghost" size="sm" icon title="Remove provider" aria-label={`Remove ${provider.name}`} onClick={onDelete}>
          <Trash2 size={13} />
        </Button>
      )}
      <Switch checked={provider.enabled} onChange={onToggle} label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`} />
    </SettingRow>
  );
}

// ─── Chat's API providers (Settings › Chat › Accounts) ───────────────────────

/** The types Chat's "API" runner talks to; mirrors `API_TYPES` in chat_runtime/api.rs. */
const CHAT_API_TYPES: readonly string[] = ["openai-compat", "ollama"];

/** OpenAI-compatible providers for Chat's API runner: add, edit, turn off, remove. `onChange`
 *  runs after each saved change, so open model pickers can ask again. */
export function ChatApiProviders({ onChange }: { onChange: () => void }) {
  const { providers, loading, error, upsertProvider, deleteProvider } = useModelRegistry();
  // The form sits in the page (Settings is already a modal): "new", a provider id, or closed.
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const api = providers.filter((p) => CHAT_API_TYPES.includes(p.type));
  const close = () => setEditing(null);

  const change = async (work: Promise<void>) => {
    try {
      await work;
      onChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };
  const form = (provider: ProviderConfig | null) => (
    <ProviderFormModal
      open
      inline
      apiOnly
      provider={provider}
      onClose={close}
      onSave={async (saved) => {
        await upsertProvider(saved);
        onChange();
        close();
      }}
    />
  );

  if (loading) return <SettingRow label="API providers" description="Reading providers…" />;
  if (error) return <SettingRow label="API providers" description={<span className="text-(--ui-err)">Failed to load providers: {error}</span>} />;

  return (
    <>
      {api.map((provider) =>
        editing === provider.id ? (
          <div key={provider.id} className="p-2">
            {form(provider)}
          </div>
        ) : (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onEdit={() => setEditing(provider.id)}
            onDelete={() => confirm("Remove this provider? This cannot be undone.") && void change(deleteProvider(provider.id))}
            onToggle={(enabled) => void change(upsertProvider({ ...provider, enabled }))}
          />
        ),
      )}
      {editing === "new" ? (
        <div className="p-2">{form(null)}</div>
      ) : editing === null ? (
        <SettingRow
          label={api.length === 0 ? "No providers yet" : "Another endpoint"}
          description={api.length === 0 ? "Add one to chat with DeepSeek, OpenRouter, a local Ollama and more." : undefined}
        >
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={13} />
            Add provider
          </Button>
        </SettingRow>
      ) : null}
    </>
  );
}
