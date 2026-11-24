"use client";

import { Check, ChevronRight, Eye, FileText, Pencil, RotateCcw, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { DetailHeader, IconButton } from "@/components/resource/resource-kit";
import { NumberStepper } from "@/components/ui/number-stepper";
import type { FactoryAgentDefinition, FactoryAgentEdit, FactoryCatalog, FactoryDefinition } from "@/lib/tauri/graph-run";
import { FactoryCapabilityMap } from "./FactoryCapabilityMap";
import { CatalogPicker } from "./FactoryCatalogPicker";
import { FactoryRoleIcon } from "./factory-role-icon";
import {
  FACTORY_FILE,
  agentPath,
  editOf,
  missingNames,
  modelLabel,
  roleKit,
  sameEdit,
  toggled,
  type RoleKit,
} from "../services/factory-agents";

// The backend's own numbers: definition.rs refuses a timeout_minutes or max_questions outside 1..=these,
// and runner.rs runs triage, spec and review for DEFAULT_SPEC_TIMEOUT (20 min) when none is set.
const MAX_TIMEOUT_MINUTES = 240;
const MAX_QUESTIONS = 50;
const DEFAULT_TIMEOUT_MINUTES = 20;
const TIMED_ROLES: FactoryAgentDefinition["role"][] = ["triage", "spec", "review"];

type Kind = "skills" | "mcp";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** One role, editable. Save writes its file in the checkout; Use built-in deletes it. */
export function FactoryAgentPane({
  agent,
  builtInPrompt,
  shared,
  catalog,
  presets,
  unpushed,
  privateFactory = false,
  onSave,
  onClose,
}: {
  agent: FactoryAgentDefinition;
  /** Every agent's names: what a run of this role gets before its own. */
  shared: { skills: string[]; mcp: string[] };
  builtInPrompt: string;
  catalog: FactoryCatalog | null;
  presets: { id: string; name: string }[];
  unpushed: boolean;
  /** Lotus's private factory (#169): saved on this Mac, never in the repo. */
  privateFactory?: boolean;
  /** `null` = Use built-in. Rejects with why it was refused. */
  onSave: (edit: FactoryAgentEdit | null) => Promise<void>;
  onClose: () => void;
}) {
  const saved = editOf(agent);
  const [draft, setDraft] = useState<FactoryAgentEdit>(saved);
  const [timeout, setTimeoutMinutes] = useState(saved.timeoutMinutes);
  const [questions, setQuestions] = useState(saved.maxQuestions);
  const [picking, setPicking] = useState<Kind | null>(null);
  // A customized prompt opens by itself: the one case where the reader needs to see it.
  const [editingPrompt, setEditingPrompt] = useState(saved.prompt.trim() !== builtInPrompt.trim());
  const [customModel, setCustomModel] = useState(Boolean(saved.model));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit: FactoryAgentEdit = { ...draft, timeoutMinutes: timeout, maxQuestions: questions };
  const dirty = !sameEdit(edit, saved);
  const set = (patch: Partial<FactoryAgentEdit>) => setDraft((d) => ({ ...d, ...patch }));
  const triage = agent.role === "triage";
  const timed = TIMED_ROLES.includes(agent.role);
  const asks = agent.role === "spec";

  const run = async (next: FactoryAgentEdit | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };
  const discard = () => {
    setDraft(saved);
    setTimeoutMinutes(saved.timeoutMinutes);
    setQuestions(saved.maxQuestions);
    setPicking(null);
    setError(null);
  };
  const kit = roleKit(agent.role, shared, draft, catalog);
  const presetKnown = !draft.preset || presets.some((p) => p.id === draft.preset);
  const customPrompt = draft.prompt.trim() !== builtInPrompt.trim();
  const promptLines = draft.prompt.trim().split("\n").length;

  return (
    <div className="fa-agent-pane">
      <DetailHeader
        level={2}
        title={agent.role.charAt(0).toUpperCase() + agent.role.slice(1)}
        meta={
          <>
            <span className="fa-access" data-full={agent.access === "full" ? "true" : undefined}>
              {agent.access === "full" ? <Pencil size={11} aria-hidden /> : <Eye size={11} aria-hidden />}
              {agent.access === "full" ? "Full access" : "Read-only"}
            </span>
            <span className="fa-agents-file">{agent.source ?? `built in · saves to ${agentPath(agent.role)}`}</span>
            {unpushed ? <span className="fa-unpushed">not pushed</span> : null}
          </>
        }
        actions={
          <IconButton label="Close agent settings (Esc)" onClick={onClose}>
            <X size={15} strokeWidth={1.75} aria-hidden />
          </IconButton>
        }
      />
      <FormRow title="Model" hint="Which agent preset runs this role.">
        <select
          className="fa-input"
          aria-label="Model"
          value={draft.preset ?? ""}
          onChange={(e) => set({ preset: e.target.value || null })}
        >
          <option value="">{agent.role === "implement" ? "Pick at New run" : "Same as implementer"}</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {presetKnown ? null : <option value={draft.preset!}>{draft.preset} (not in your presets)</option>}
        </select>
        {/* Most people pick a preset; a saved custom name opens this by itself. */}
        <button type="button" className="fa-disclose" aria-expanded={customModel} onClick={() => setCustomModel(!customModel)}>
          <ChevronRight size={12} aria-hidden />
          Custom model name
          <span className="fa-disclose-note">optional</span>
        </button>
        {customModel ? (
          <input
            className="fa-input"
            aria-label="Model name"
            placeholder="e.g. opus or sonnet"
            value={draft.model ?? ""}
            onChange={(e) => set({ model: e.target.value.trim() ? e.target.value : null })}
          />
        ) : null}
        {agent.role === "review" ? null : (
          <p className="fa-pane-hint">{agent.access === "full" ? "Full access: this agent edits the worktree." : "Read-only: only implement edits the code."}</p>
        )}
        {triage ? <p className="fa-pane-hint">Triage never gets an MCP server: it reads only the ticket and the code.</p> : null}
      </FormRow>
      {agent.role === "review" ? (
        <FormRow title="Second opinion" hint="Review is worth most on a different model.">
          <label className="fa-switch-row">
            <input type="checkbox" role="switch" className="fa-switch" checked={draft.sameModel} onChange={(e) => set({ sameModel: e.target.checked })} />
            <span className="fa-switch-text">
              <span className="fa-switch-label">Allow the same model as Implement</span>
              <span className="fa-pane-hint" data-tone={draft.sameModel ? "attention" : undefined}>
                {draft.sameModel
                  ? "On: Review runs even on the same model. It is a weaker check."
                  : "Off: Review runs only on another preset or model. If both are the same, the run stops before review."}
              </span>
            </span>
          </label>
        </FormRow>
      ) : null}
      <FormRow title="Skills and servers" hint="Shared ones come first, then this role's own. × removes, + adds.">
        <FactoryCapabilityMap
          label={agent.role}
          model={modelLabel({ ...agent, preset: draft.preset, model: draft.model }, presets)}
          access={agent.access}
          icon={<FactoryRoleIcon role={agent.role} size={22} />}
          kit={kit}
          canEdit={Boolean(catalog)}
          onRemove={(kind, name) => set(kind === "skills" ? { skills: draft.skills.filter((n) => n !== name) } : { mcp: draft.mcp.filter((n) => n !== name) })}
          onAdd={setPicking}
          picker={pickerFor(picking, catalog, draft, set, () => setPicking(null))}
        />
      </FormRow>
      {/* Only these runs read timeout_minutes (runner.rs); implement and handoff do not yet, so a
          value there would be a promise the runner breaks. A saved one is kept, just not offered. */}
      {timed ? (
        <FormRow title="Timeout" hint={`${agent.role[0].toUpperCase()}${agent.role.slice(1)} stops after this long.`}>
          <NumberStepper
            label="Timeout, minutes"
            min={1}
            max={MAX_TIMEOUT_MINUTES}
            step={5}
            snap
            page={60}
            unit="min"
            value={timeout}
            onChange={(n: number | null) => setTimeoutMinutes(n)}
            empty={{ label: `${DEFAULT_TIMEOUT_MINUTES} min · default`, start: DEFAULT_TIMEOUT_MINUTES }}
          />
        </FormRow>
      ) : null}
      {asks ? (
        <FormRow title="Questions" hint="Most questions spec asks in one round.">
          <NumberStepper
            label="Questions per round"
            min={1}
            max={MAX_QUESTIONS}
            value={questions}
            onChange={(n: number | null) => setQuestions(n)}
            empty={{ label: "no cap" }}
          />
        </FormRow>
      ) : null}
      <FormRow title="Prompt" hint="Change it only to make this role act differently.">
        {editingPrompt ? (
          <>
            <textarea
              className="fa-textarea fa-spec-edit"
              aria-label="Prompt"
              rows={12}
              value={draft.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
            />
            {customPrompt ? (
              <button type="button" className="fa-link fa-prompt-reset" onClick={() => set({ prompt: builtInPrompt })}>
                Use the built-in prompt
              </button>
            ) : null}
          </>
        ) : (
          <div className="fa-prompt-row">
            <FileText size={14} aria-hidden />
            <span className="fa-prompt-text">
              <span className="fa-switch-label">Built-in prompt</span>
              <span className="fa-pane-hint">
                {promptLines} line{promptLines === 1 ? "" : "s"}
              </span>
            </span>
            <button type="button" className="rs-button" onClick={() => setEditingPrompt(true)}>
              Edit prompt
            </button>
          </div>
        )}
      </FormRow>
      <PaneFooter
        privateFactory={privateFactory}
        error={error}
        busy={busy}
        dirty={dirty}
        onDiscard={discard}
        onSave={() => run(edit)}
        reset={agent.source ? () => run(null) : undefined}
      />
    </div>
  );
}

/** The catalog picker for one side of the map; ticking toggles the role's own names. */
function pickerFor(
  kind: Kind | null,
  catalog: FactoryCatalog | null,
  draft: { skills: string[]; mcp: string[] },
  set: (patch: Partial<FactoryAgentEdit>) => void,
  onClose: () => void,
) {
  if (!kind || !catalog) return null;
  return (
    <CatalogPicker
      kind={kind}
      catalog={catalog}
      chosen={draft[kind]}
      onToggle={(name) => set(kind === "skills" ? { skills: toggled(draft.skills, name) } : { mcp: toggled(draft.mcp, name) })}
      onClose={onClose}
    />
  );
}

/** Shared skills and MCP servers (`.lotus/factory.toml`), separate from Factory check policy. */
export function FactorySharedPane({
  definition,
  catalog,
  unpushed,
  privateFactory = false,
  onSave,
  onClose,
}: {
  definition: FactoryDefinition;
  catalog: FactoryCatalog | null;
  unpushed: boolean;
  /** Lotus's private factory (#169): saved on this Mac, never in the repo. */
  privateFactory?: boolean;
  onSave: (skills: string[], mcp: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState(definition.skills);
  const [mcp, setMcp] = useState(definition.mcp);
  const [picking, setPicking] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const same = (a: string[], b: string[]) => a.join("\n") === b.join("\n");
  const dirty = !same(skills, definition.skills) || !same(mcp, definition.mcp);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(skills, mcp);
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };
  // Every name here is the set's own: the "shared" distinction only exists from a role's point of view.
  const named = (names: string[], kind: Kind) => {
    const missing = new Set(missingNames(names, kind, catalog));
    return names.map((name) => ({ name, shared: false, missing: missing.has(name) }));
  };
  const kit: RoleKit = { skills: named(skills, "skills"), mcp: named(mcp, "mcp"), noMcp: false };
  return (
    <div className="fa-agent-pane">
      <DetailHeader
        level={2}
        title="Shared by all roles"
        meta={
          <>
            <span className="fa-agents-file">{FACTORY_FILE}</span>
            {unpushed ? <span className="fa-unpushed">not pushed</span> : null}
          </>
        }
        actions={
          <IconButton label="Close agent settings (Esc)" onClick={onClose}>
            <X size={15} strokeWidth={1.75} aria-hidden />
          </IconButton>
        }
      />
      <FormRow title="What every role gets" hint="Skills apply to every role. Shared MCP servers apply to every role except Triage. Edit checks in the Checks view.">
        <FactoryCapabilityMap
          label="All roles"
          ownCaption="every role"
          model={null}
          access={null}
          icon={<FactoryRoleIcon role="shared" size={22} />}
          kit={kit}
          canEdit={Boolean(catalog)}
          onRemove={(kind, name) => (kind === "skills" ? setSkills(skills.filter((n) => n !== name)) : setMcp(mcp.filter((n) => n !== name)))}
          onAdd={setPicking}
          picker={
            picking && catalog ? (
              <CatalogPicker
                kind={picking}
                catalog={catalog}
                chosen={picking === "skills" ? skills : mcp}
                onToggle={(name) => (picking === "skills" ? setSkills(toggled(skills, name)) : setMcp(toggled(mcp, name)))}
                onClose={() => setPicking(null)}
              />
            ) : null
          }
        />
      </FormRow>
      <PaneFooter
        error={error}
        busy={busy}
        dirty={dirty}
        privateFactory={privateFactory}
        onDiscard={() => (setSkills(definition.skills), setMcp(definition.mcp), setPicking(null), setError(null))}
        onSave={save}
      />
    </div>
  );
}

/** One setting: its name and a short why in the label column, the control beside it. */
function FormRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="fa-form-row" aria-labelledby={id}>
      <div className="fa-form-label">
        <h3 id={id}>{title}</h3>
        {hint ? <p>{hint}</p> : null}
      </div>
      <div className="fa-form-control">{children}</div>
    </section>
  );
}

function PaneFooter({
  error,
  busy,
  dirty,
  onDiscard,
  onSave,
  reset,
  privateFactory,
}: {
  error: string | null;
  busy: boolean;
  dirty: boolean;
  privateFactory: boolean;
  onDiscard: () => void;
  onSave: () => void;
  reset?: () => void;
}) {
  return (
    <div className="fa-pane-foot">
      {error ? (
        <p role="alert" className="fa-agents-alert">
          Not saved: {error}
        </p>
      ) : null}
      <div className="fa-pane-actions">
        {reset ? (
          <button type="button" className="rs-button rs-button--ghost" onClick={reset} disabled={busy} title="Delete this role's file">
            <RotateCcw size={13} aria-hidden />
            Use built-in
          </button>
        ) : null}
        <span className="fa-pane-state" data-dirty={dirty ? "true" : undefined} role="status">
          {dirty ? null : <Check size={12} aria-hidden />}
          {dirty ? "Unsaved changes" : privateFactory ? "Saved on this Mac" : "Saved"}
        </span>
        <span className="fa-agents-gap" />
        {/* Clean, the pair steps back; dirty, Save becomes the pane's one primary. */}
        <button type="button" className="rs-button rs-button--ghost" onClick={onDiscard} disabled={busy || !dirty}>
          Discard
        </button>
        <button type="button" className={dirty ? "rs-button rs-button--primary" : "rs-button"} onClick={onSave} disabled={busy || !dirty}>
          {busy ? "Saving…" : privateFactory ? "Save on this Mac" : "Save to repo"}
        </button>
      </div>
    </div>
  );
}
