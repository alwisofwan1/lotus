"use client";

import { ChevronDown, ChevronRight, Copy, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { listAccounts } from "@/lib/tauri-api";
import type { ReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import { listAgentModels } from "@/lib/tauri/agent-models";
import { discoverAgentCliModels, getAgentCliAvailability } from "@/lib/tauri/agent-cli";
import {
  AgentModelPicker,
  joinAgent,
  pickerProgram,
  splitAgent,
  type AgentProbe,
  type PickerAgent,
} from "@/modules/tasks/components/AgentModelPicker";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import { presetRefusalMessage, type DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import {
  composePresetArgs,
  overriddenByExtra,
  permissionFlag,
  presetFamily,
  readPresetTuning,
  tunesModel,
  type PresetPermission,
} from "@/modules/tasks/services/preset-tuning";

/**
 * Making or editing an agent preset — opened from the Tasks sidebar and from Delegate.
 *
 * bb's editor (`plugins/tasks/views/manage/preset-dialog.tsx`) picks provider, model, reasoning
 * and permissions; this one does too, with one difference that matters: Lotus spawns a COMMAND,
 * so every choice is written back as that CLI's own flags (`preset-tuning.ts`) and stored in
 * `args`, the one field Automations and Factory also read. A picker only offers what its agent's
 * CLI accepts; anything else is an extra flag, under Advanced.
 */

export type PresetDraft = Omit<DelegationPreset, "id">;

export interface PresetEditorModalProps {
  /** Absent for "New preset". */
  preset?: DelegationPreset;
  /** Resolves to a refusal message, or null when saved. */
  onSave: (draft: PresetDraft) => Promise<string | null>;
  onRemove?: () => void;
  onClose: () => void;
}

/** What each CLI said about itself, kept for the app's lifetime: a PATH does not move mid-session. */
const probeCache = new Map<PickerAgent, AgentProbe>();

const NAME_REFUSALS = new Set([presetRefusalMessage("empty-name"), presetRefusalMessage("duplicate-name")]);

export function PresetEditorModal({ preset, onSave, onRemove, onClose }: PresetEditorModalProps) {
  const headingId = useId();
  const nameId = useId();
  const modelLabelId = useId();
  const permissionLabelId = useId();
  const accountLabelId = useId();
  const initial = splitAgent(preset?.agent ?? "claude");
  const tuning = readPresetTuning(preset?.agent ?? "claude", preset?.args ?? "");

  const [name, setName] = useState(preset?.name ?? "");
  const [agent, setAgent] = useState<PickerAgent>(initial.id);
  const [profile, setProfile] = useState(initial.profile);
  const [custom, setCustom] = useState(initial.custom);
  const [model, setModel] = useState<string | null>(tuning.model);
  const [effort, setEffort] = useState<ReasoningLevel | null>(tuning.effort);
  const [permission, setPermission] = useState<PresetPermission>(tuning.permission ?? "safe");
  const [extra, setExtra] = useState(tuning.extra);
  const [instructions, setInstructions] = useState(preset?.instructions ?? "");
  const [account, setAccount] = useState(preset?.account ?? "");
  // Signed-in accounts other than the default; asked once per open, like the agent probes.
  const [accounts, setAccounts] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void listAccounts()
      .then((rows) => { if (live) setAccounts(rows.filter((a) => a.id !== "default" && a.identity).map((a) => a.id)); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const [advanced, setAdvanced] = useState(Boolean(tuning.extra) || initial.id === "custom");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probes, setProbes] = useState<Partial<Record<PickerAgent, AgentProbe>>>(() => Object.fromEntries(probeCache));

  const agentText = joinAgent(agent, profile, custom);
  const family = presetFamily(agentText);
  const skipFlag = permissionFlag(family);
  const args = composePresetArgs(agentText, {
    model: tunesModel(family) ? model : null,
    effort: tunesModel(family) ? effort : null,
    permission: skipFlag ? permission : null,
    extra,
  });
  const command = [agentText || "…", args].filter(Boolean).join(" ");
  const overridden = overriddenByExtra(agentText, extra);

  const probe = useCallback((id: PickerAgent) => {
    if (probeCache.has(id) || id === "custom") return;
    probeCache.set(id, {});
    const program = pickerProgram(id, "");
    // ccs forwards Claude's flags, so Claude's list is the honest one to offer under it.
    const discoverAs = id === "ccs" ? "claude" : id;
    const tuned = tunesModel(presetFamily(discoverAs));
    void Promise.all([
      getAgentCliAvailability([program], { probeAuth: false }).catch(() => null),
      // The CLI's own list first (bb's way); `--help` + catalog only when it gave none.
      tuned ? listAgentModels(discoverAs) : Promise.resolve(null),
    ]).then(async ([availability, live]) => {
      const discovered =
        tuned && !live?.length ? await discoverAgentCliModels(discoverAs, [discoverAs]).catch(() => null) : null;
      const next: AgentProbe = {
        ...(availability ? { installed: availability.available } : {}),
        ...(discovered ? { models: discovered.models } : {}),
        ...(live?.length ? { live } : {}),
      };
      probeCache.set(id, next);
      setProbes((current) => ({ ...current, [id]: next }));
    });
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    const message = await onSave({ name, agent: agentText, args, instructions, ...(agent === "claude" && account ? { account } : {}) });
    setBusy(false);
    setRefusal(message);
    if (!message) onClose();
  }

  const nameError = refusal && NAME_REFUSALS.has(refusal) ? refusal : null;
  const otherError = refusal && !nameError ? refusal : null;
  const installed = probes[agent]?.installed;

  return (
    <TasksModal labelledBy={headingId} onClose={onClose} className="tk-modal--preset">
      <form
        className="tk-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="tk-form-head">
          <h2 id={headingId} className="tk-form-title">
            {preset ? "Edit preset" : "New preset"}
          </h2>
          <p className="tk-form-lede">Who runs delegated tasks, how hard they think, and what they may touch.</p>
        </header>

        <div className="tk-field">
          <label className="tk-field-label" htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            autoFocus
            className="tk-input"
            value={name}
            placeholder="e.g. Sonnet · careful"
            aria-invalid={Boolean(nameError) || undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameError ? <p className="tk-field-error">{nameError}</p> : null}
        </div>

        <div className="tk-field">
          <span className="tk-field-label" id={modelLabelId}>
            Agent and model
          </span>
          <AgentModelPicker
            labelledBy={modelLabelId}
            value={{ agent, model, effort }}
            probes={probes}
            onProbe={probe}
            onChange={(next) => {
              if (next.agent !== agent) probe(next.agent);
              setAgent(next.agent);
              setModel(next.model);
              setEffort(next.effort);
              if (next.agent === "custom") setAdvanced(true);
            }}
          />
          {agent === "ccs" ? (
            <input
              className="tk-input tk-input--mono"
              value={profile}
              spellCheck={false}
              aria-label="ccs profile"
              placeholder="Profile, e.g. acme"
              onChange={(event) => setProfile(event.target.value)}
            />
          ) : null}
          {agent === "custom" ? (
            <input
              className="tk-input tk-input--mono"
              value={custom}
              spellCheck={false}
              aria-label="Command"
              placeholder="Any command on PATH that takes a prompt, e.g. gh copilot"
              onChange={(event) => setCustom(event.target.value)}
            />
          ) : null}
          {installed !== undefined ? (
            <p className="tk-field-hint tk-pick-probe" data-ok={installed || undefined}>
              <span className="tk-dot" aria-hidden />
              {installed
                ? `${pickerProgram(agent, custom)} found on PATH`
                : `${pickerProgram(agent, custom)} not found on PATH. Install it, or pick another agent.`}
            </p>
          ) : null}
        </div>

        {agent === "claude" && (accounts.length > 0 || account) ? (
          <div className="tk-field">
            <span className="tk-field-label" id={accountLabelId}>
              Account
            </span>
            <div className="tk-seg" role="radiogroup" aria-labelledby={accountLabelId}>
              {["", ...accounts, ...(account && !accounts.includes(account) ? [account] : [])].map((value) => (
                <button
                  key={value || "auto"}
                  type="button"
                  role="radio"
                  aria-checked={account === value}
                  className="tk-seg-option"
                  onClick={() => setAccount(value)}
                >
                  {value || "Auto"}
                </button>
              ))}
            </div>
            <p className="tk-field-hint">Auto runs on the account chosen in Settings.</p>
          </div>
        ) : null}

        <div className="tk-field">
          <span className="tk-field-label" id={permissionLabelId}>
            Permissions
          </span>
          {skipFlag ? (
            <>
              <div className="tk-seg tk-seg--perm" role="radiogroup" aria-labelledby={permissionLabelId}>
                {(["safe", "yolo"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={permission === value}
                    className="tk-seg-option"
                    data-tone={value === "yolo" ? "warn" : undefined}
                    onClick={() => setPermission(value)}
                  >
                    <PermissionIcon value={value} />
                    {value === "yolo" ? "Full access" : "Ask first"}
                  </button>
                ))}
              </div>
              <p className="tk-field-hint" data-tone={permission === "yolo" ? "warn" : undefined}>
                {PERMISSION_COPY[permission]}
                {permission === "yolo" ? <code className="tk-perm-flag">{skipFlag}</code> : null}
              </p>
            </>
          ) : (
            <p className="tk-field-hint">This agent decides its own approvals; Lotus has no flag to change them.</p>
          )}
        </div>

        <label className="tk-field">
          <span className="tk-field-label">Instructions</span>
          <textarea
            className="tk-input tk-input--area"
            value={instructions}
            rows={4}
            placeholder="Run the tests before you say done."
            onChange={(event) => setInstructions(event.target.value)}
          />
          <span className="tk-field-hint">Added after the task text, every time this preset runs.</span>
        </label>

        <section className="tk-advanced">
          <button
            type="button"
            className="tk-advanced-toggle"
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
          >
            {advanced ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            <span>Advanced</span>
            {!advanced ? <span className="tk-advanced-summary">Extra flags · full command</span> : null}
          </button>
          {advanced ? (
            <div className="tk-advanced-body">
              <label className="tk-field">
                <span className="tk-field-label">Extra flags</span>
                <input
                  className="tk-input tk-input--mono"
                  value={extra}
                  spellCheck={false}
                  placeholder="--verbose"
                  data-tone={overridden.length ? "warn" : undefined}
                  onChange={(event) => setExtra(event.target.value)}
                />
                {overridden.length ? (
                  <span className="tk-field-warn">
                    <TriangleAlert size={13} aria-hidden />
                    {overridden.join(", ")} here overrides the picker above. Pick it there instead.
                  </span>
                ) : null}
              </label>
              <div className="tk-field">
                <div className="tk-field-label-row">
                  <span className="tk-field-label">Runs as</span>
                  <button
                    type="button"
                    className="tk-icon-button"
                    aria-label="Copy command"
                    title="Copy command"
                    onClick={() => void navigator.clipboard?.writeText(command).catch(() => undefined)}
                  >
                    <Copy size={13} aria-hidden />
                  </button>
                </div>
                <code className="tk-command">{command}</code>
                <span className="tk-field-hint">A new pane gets exactly this, plus the task.</span>
              </div>
            </div>
          ) : null}
        </section>

        {otherError ? <p className="tk-modal-refusal">{otherError}</p> : null}

        <footer className="tk-form-foot">
          {preset && onRemove ? (
            confirmDelete ? (
              <>
                <span className="tk-confirm-ask">Delete “{preset.name}”?</span>
                <button type="button" className="tk-button" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
                <button
                  type="button"
                  className="tk-button tk-button--destructive"
                  onClick={() => {
                    onRemove();
                    onClose();
                  }}
                >
                  Delete
                </button>
              </>
            ) : (
              <button type="button" className="tk-button tk-button--danger" onClick={() => setConfirmDelete(true)}>
                Delete preset
              </button>
            )
          ) : null}
          {!confirmDelete ? (
            <>
              <button type="button" className="tk-button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="tk-button tk-button--primary" disabled={busy}>
                {busy ? "Saving…" : "Save preset"}
              </button>
            </>
          ) : null}
        </footer>
      </form>
    </TasksModal>
  );
}

const PERMISSION_COPY: Record<PresetPermission, string> = {
  safe: "The agent asks you in its pane before it edits files or runs commands.",
  yolo: "No approvals — the agent can run anything on this Mac.",
};

function PermissionIcon({ value }: { value: PresetPermission }) {
  return value === "yolo" ? (
    <ShieldAlert size={14} strokeWidth={1.75} aria-hidden className="tk-perm-icon" />
  ) : (
    <ShieldCheck size={14} strokeWidth={1.75} aria-hidden className="tk-perm-icon" />
  );
}
