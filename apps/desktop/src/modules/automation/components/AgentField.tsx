"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { getSettings, saveSettings } from "@/lib/tauri-api";
import { ChatAccountPicker, useClaudeAccountChoices } from "@/modules/chat/ui/ChatAccount";
import { ChatModelPicker, useChatModels } from "@/modules/chat/ui/ChatModel";
import { emitLotusSettingsChanged } from "@/modules/settings/services/settings-events";
import type { ClaudeSettings } from "@/modules/settings/types";
import {
  prepareDelegationPreset,
  presetRefusalMessage,
  resolveDelegationPresets,
} from "@/modules/tasks/services/delegation-preset";
import type { AgentPreset } from "../services/automation-api";
import { composeAgentRef, parseAgentRef, setFlag } from "../services/agent-ref";

const CLAUDE_ONLY = ["claude"] as const;

/**
 * Which agent runs an automation (mockups/automation-agent-health.html, view 2): a saved agent,
 * then the composer's model + effort picker and the account picker on top. `value` is an agent ref
 * (`agent-ref.ts`); a pick calls `onChange` with the new ref.
 */
export function AgentField({
  presets,
  value,
  onChange,
  disabled = false,
}: {
  presets: AgentPreset[];
  value: string;
  onChange: (ref: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const ref = parseAgentRef(value);
  const preset = presets.find((p) => p.id === ref.presetId);
  const claude = preset?.agent.split(/\s+/)[0] === "claude";
  const { models, error } = useChatModels(claude ? "claude" : null);
  const [accounts, refreshAccounts] = useClaudeAccountChoices(null, false);
  const account = ref.account ?? preset?.account ?? accounts.find((a) => a.inUse)?.account ?? null;
  const pick = (patch: Partial<typeof ref>) => onChange(composeAgentRef({ ...ref, ...patch }));
  const broken = !preset || !preset.supported;

  return (
    <div className="au-agent">
      <span className="au-agent-preset-wrap">
      <select
        className="au-input au-agent-preset"
        data-broken={broken || undefined}
        aria-label="Agent"
        disabled={disabled}
        value={preset ? ref.presetId : ""}
        // Another saved agent starts from its own model and account.
        onChange={(e) => void onChange(e.target.value)}
      >
        {!preset && <option value="">{ref.presetId ? "Missing agent — choose one" : "Choose an agent"}</option>}
        {presets.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.supported}>
            {p.name}
            {p.supported ? "" : ` — ${p.problem ?? "cannot run here"}`}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="au-agent-preset-caret" aria-hidden />
      </span>
      {claude && (
        <ChatModelPicker
          models={models}
          error={error}
          current={ref.model ?? preset?.model ?? null}
          effort={ref.effort ?? preset?.effort ?? null}
          runner="claude"
          runners={CLAUDE_ONLY}
          below
          onPick={async (model, _label, effort) => {
            // "default" is the CLI's own choice: no --model at all.
            await pick({ model: model === "default" ? undefined : model, effort });
          }}
        />
      )}
      {claude && (
        <ChatAccountPicker
          accounts={accounts}
          current={account}
          disabled={disabled}
          subject="This automation"
          below
          footer="Applies from the next run."
          onOpen={refreshAccounts}
          onPick={async (id) => {
            await pick({ account: id });
          }}
        />
      )}
      {preset && claude && (ref.model || ref.effort || ref.account) && (
        <SaveAsAgent base={preset.id} value={value} onSaved={(id) => void onChange(id)} />
      )}
      {preset && !preset.supported && preset.problem && <span className="au-error">{preset.problem}</span>}
    </div>
  );
}

/** Keeps this model, effort and account as a new saved agent, the same list Tasks uses. */
function SaveAsAgent({ base, value, onSaved }: { base: string; value: string; onSaved: (id: string) => void }) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (name === null) {
    return (
      <button type="button" className="au-link" onClick={() => setName("")}>
        Save as agent…
      </button>
    );
  }
  const save = async () => {
    const settings = (await getSettings()) as ClaudeSettings;
    const presets = resolveDelegationPresets(settings);
    const from = presets.find((p) => p.id === base);
    if (!from) return setError("That agent was deleted.");
    const { model, effort, account } = parseAgentRef(value);
    let args = from.args;
    if (model) args = setFlag(args, "--model", model);
    if (effort) args = setFlag(args, "--effort", effort);
    const runsOn = account ?? from.account;
    const draft = { name, agent: from.agent, args, instructions: from.instructions, ...(runsOn ? { account: runsOn } : {}) };
    const prepared = prepareDelegationPreset(draft, presets);
    if (!prepared.ok) return setError(presetRefusalMessage(prepared.reason));
    const merged = { ...settings, delegation: { presets: [...presets, prepared.preset] } };
    await saveSettings(merged);
    emitLotusSettingsChanged(merged as unknown as Record<string, unknown>);
    setName(null);
    onSaved(prepared.preset.id);
  };
  return (
    <span className="au-agent-save">
      <input
        className="au-input"
        autoFocus
        placeholder="Agent name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save().catch((err) => setError(String(err)));
          if (e.key === "Escape") setName(null);
        }}
      />
      <button type="button" className="au-chip" onClick={() => void save().catch((err) => setError(String(err)))}>
        Save
      </button>
      {error && <span className="au-error">{error}</span>}
    </span>
  );
}
