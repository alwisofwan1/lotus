"use client";

import { Check, ChevronsUpDown, Search, SquareTerminal } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import { reconcileReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";
import { formatModelLabel } from "@/modules/agents/services/model-discovery";
import type { LiveAgentModel } from "@/lib/tauri/agent-models";
import {
  chosenChoice,
  effortLabel,
  presetEfforts,
  presetFamily,
  presetModelChoices,
  tunesModel,
  type PresetModelChoice,
} from "@/modules/tasks/services/preset-tuning";

/**
 * Agent, model and reasoning behind one trigger — bb's `ModelReasoningPicker` shape, cut to what a
 * preset can honestly set. Tabs PREVIEW an agent's models; nothing changes until a row is picked,
 * and picking a row under another tab is what switches the agent.
 *
 * Every row here becomes a flag (`preset-tuning.ts`). An agent with no model flag shows only
 * "CLI default", and the reasoning row appears only where an effort flag exists. No fast mode: no
 * CLI here has a verified flag for it.
 */

export type PickerAgent = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "ccs" | "custom";

/**
 * The vendor artwork from `public/assets/ai-logo/` — the same files pane headers and CodeCanvas
 * mask (`pane-runner-identity.ts`), so one agent has one silhouette everywhere. `ccs` wraps Claude
 * and wears its mark; "Other" is any command and gets a terminal glyph, not a borrowed logo.
 */
export const PICKER_AGENTS: readonly { id: PickerAgent; label: string; logo: string | null; title: string }[] = [
  { id: "claude", label: "Claude", logo: "/assets/ai-logo/Claude.svg", title: "Claude Code" },
  { id: "codex", label: "Codex", logo: "/assets/ai-logo/ChatGPT.svg", title: "Codex" },
  { id: "cursor", label: "Cursor", logo: "/assets/ai-logo/Cursor.svg", title: "Cursor" },
  { id: "gemini", label: "Gemini", logo: "/assets/ai-logo/Gemini.svg", title: "Gemini CLI" },
  { id: "opencode", label: "opencode", logo: "/assets/ai-logo/Opencode.svg", title: "opencode" },
  { id: "ccs", label: "ccs", logo: "/assets/ai-logo/Claude.svg", title: "ccs — a Claude profile" },
  { id: "custom", label: "Other", logo: null, title: "Another command" },
];

/** An agent's mark, painted in `currentColor` through the logo as a mask — never in brand colour. */
export function AgentMark({ agent, size = 16 }: { agent: PickerAgent; size?: number }) {
  const logo = PICKER_AGENTS.find((entry) => entry.id === agent)?.logo;
  if (!logo) return <SquareTerminal size={size} strokeWidth={1.75} aria-hidden className="tk-agent-glyph" />;
  return (
    <span
      aria-hidden
      className="tk-agent-logo"
      style={{ width: size, height: size, ["--tk-agent-logo" as string]: `url("${logo}")` }}
    />
  );
}

/** The program behind a tab, as the CLI is named on PATH. */
export function pickerProgram(id: PickerAgent, custom: string): string {
  return id === "custom" ? custom.trim().split(/\s+/)[0] ?? "" : id;
}

const NAMED: readonly PickerAgent[] = ["claude", "codex", "cursor", "gemini", "opencode"];

/** The tab a saved `agent` belongs to, and what the tab's own field holds. */
export function splitAgent(agent: string): { id: PickerAgent; profile: string; custom: string } {
  const [program = "", ...rest] = agent.trim().split(/\s+/);
  if (program === "ccs") return { id: "ccs", profile: rest.join(" "), custom: "" };
  if ((NAMED as readonly string[]).includes(program) && rest.length === 0) {
    return { id: program as PickerAgent, profile: "", custom: "" };
  }
  return program ? { id: "custom", profile: "", custom: agent.trim() } : { id: "claude", profile: "", custom: "" };
}

export function joinAgent(id: PickerAgent, profile: string, custom: string): string {
  if (id === "ccs") return ["ccs", profile.trim()].filter(Boolean).join(" ");
  if (id === "custom") return custom.trim();
  return id;
}

/** A saved preset's agent, as the tab it belongs to. */
export function presetAgent(agent: string): PickerAgent {
  return splitAgent(agent).id;
}

/** What the CLI reported about itself; absent while still asking or outside the desktop app. */
export interface AgentProbe {
  installed?: boolean;
  /** Model ids `--help` named — the fallback when the CLI gave no list of its own. */
  models?: readonly string[];
  /** The CLI's own list (names, order, levels), when it answered. */
  live?: readonly LiveAgentModel[] | null;
}

export interface AgentModelValue {
  agent: PickerAgent;
  model: string | null;
  effort: ReasoningLevel | null;
}

const SEARCH_ABOVE = 5;

export function AgentModelPicker({
  value,
  probes,
  onProbe,
  onChange,
  labelledBy,
}: {
  value: AgentModelValue;
  probes: Partial<Record<PickerAgent, AgentProbe>>;
  /** Asked when a tab is shown, so its models can be discovered. */
  onProbe: (agent: PickerAgent) => void;
  onChange: (next: AgentModelValue) => void;
  labelledBy: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PickerAgent>(value.agent);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const family = presetFamily(tab === "custom" ? "" : tab);
  const tuned = tunesModel(family);
  const choices = useMemo(
    () =>
      presetModelChoices(
        family,
        probes[tab]?.models ?? [],
        tab === value.agent ? value.model : null,
        formatModelLabel,
        probes[tab]?.live ?? null,
      ),
    [family, probes, tab, value.agent, value.model],
  );
  const rows: (PresetModelChoice | null)[] = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? choices.filter((c) => c.label.toLowerCase().includes(needle) || c.value.toLowerCase().includes(needle))
      : choices;
    // `null` is the "CLI default" row: first, so a preset never pins a model by accident.
    return needle ? matched : [null, ...matched];
  }, [choices, query]);

  const shownModel = tab === value.agent ? value.model : undefined;
  const efforts = presetEfforts(family, tab === value.agent ? value.model : null, choices);
  const chosen = shownModel == null ? undefined : chosenChoice(choices, shownModel);

  useEffect(() => {
    if (open) onProbe(tab);
  }, [open, tab, onProbe]);

  // Keys work from the first frame: the search box takes focus itself when it is shown.
  useEffect(() => {
    if (open && place && !panel.current?.contains(document.activeElement)) list.current?.focus();
  }, [open, place, tab]);

  // Fixed, not absolute: the modal scrolls (`overflow: auto`) and would clip a dropdown inside it.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setPlace({ top: rect.bottom + 6, left: rect.left, width: rect.width });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function show() {
    setTab(value.agent);
    setQuery("");
    setActive(0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function pickModel(model: string | null) {
    const nextFamily = presetFamily(tab === "custom" ? "" : tab);
    const supported = presetEfforts(nextFamily, model, choices);
    const effort = value.effort ? reconcileReasoningLevel(value.effort, supported) : null;
    onChange({ agent: tab, model, effort });
    close();
  }

  function stepEffort(direction: 1 | -1) {
    if (tab !== value.agent || efforts.length === 0) return;
    const scale: (ReasoningLevel | null)[] = [null, ...efforts];
    const at = scale.indexOf(value.effort);
    const next = scale[Math.min(scale.length - 1, Math.max(0, at + direction))];
    onChange({ ...value, effort: next });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // The modal closes on Escape too; this one belongs to the dropdown.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + rows.length) % Math.max(1, rows.length));
    } else if (event.key === "Enter" && tuned) {
      event.preventDefault();
      const row = rows[active];
      if (row !== undefined) pickModel(row?.value ?? null);
    } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && !query) {
      event.preventDefault();
      stepEffort(event.key === "ArrowRight" ? 1 : -1);
    }
  }

  const current = PICKER_AGENTS.find((agent) => agent.id === value.agent) ?? PICKER_AGENTS[0];
  const currentModel = value.model
    ? (chosenChoice(
        presetModelChoices(
          presetFamily(value.agent === "custom" ? "" : value.agent),
          [],
          value.model,
          formatModelLabel,
          probes[value.agent]?.live ?? null,
        ),
        value.model,
      )?.label ?? value.model)
    : "CLI default";

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="tk-pick-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelledBy}
        aria-describedby={`${listId}-value`}
        data-open={open || undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            show();
          }
        }}
      >
        <AgentMark agent={current.id} />
        <span id={`${listId}-value`} className="tk-pick-value">
          <span className="tk-pick-agent">{current.label}</span>
          <span className="tk-pick-model">{currentModel}</span>
          {value.effort ? <span className="tk-pick-effort">{effortLabel(value.effort)}</span> : null}
        </span>
        <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden className="tk-pick-chevron" />
      </button>

      {open && place ? (
        <div
          ref={panel}
          className="tk-pick-pop"
          style={{ top: place.top, left: place.left, width: Math.max(place.width, 340) }}
          onKeyDown={onKeyDown}
        >
          <div className="tk-pick-top">
            <div className="tk-seg tk-seg--agents" role="tablist" aria-label="Agent">
              {PICKER_AGENTS.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="tab"
                  aria-selected={agent.id === tab}
                  title={agent.title}
                  aria-label={agent.label}
                  className="tk-seg-option tk-seg-option--agent"
                  onClick={() => {
                    setTab(agent.id);
                    setQuery("");
                    setActive(0);
                  }}
                >
                  <AgentMark agent={agent.id} size={15} />
                </button>
              ))}
            </div>
            <div className="tk-pick-head">
              <span className="tk-pick-head-title">{PICKER_AGENTS.find((agent) => agent.id === tab)?.title}</span>
              <ProbeNote probe={probes[tab]} />
            </div>
          </div>

          {tuned && choices.length > SEARCH_ABOVE ? (
            <label className="tk-pick-search">
              <Search size={14} strokeWidth={1.75} aria-hidden />
              <input
                autoFocus
                value={query}
                placeholder="Search models"
                aria-controls={listId}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
              />
            </label>
          ) : null}

          <p className="tk-pick-section">Model</p>
          <ul ref={list} id={listId} role="listbox" aria-label="Model" className="tk-pick-list" tabIndex={-1}>
            {rows.length === 0 ? <li className="tk-pick-empty">No models match “{query}”.</li> : null}
            {rows.map((row, index) => {
              const selected = row ? row === chosen : shownModel === null;
              return (
                <li
                  key={row?.value ?? "default"}
                  role="option"
                  aria-selected={selected}
                  data-active={index === active || undefined}
                  className="tk-pick-row"
                  title={
                    row
                      ? row.stale
                        ? "Saved in this preset · not offered any more"
                        : [
                            row.description,
                            row.resolvesTo
                              ? `Always the newest of its line — runs ${row.resolvesTo} today. Pick a numbered row below to stay on one model.`
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n") || undefined
                      : tuned
                        ? `Whatever ${tab === "ccs" ? "the profile" : tab} starts on`
                        : "Lotus has no model flag for this agent"
                  }
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pickModel(row?.value ?? null)}
                >
                  <span className={row ? "tk-pick-row-name" : "tk-pick-row-name tk-pick-row-name--quiet"}>
                    {row ? row.label : "CLI default"}
                  </span>
                  {row?.stale ? <span className="tk-pick-row-tag">not offered</span> : null}
                  {row?.resolvesTo ? <span className="tk-pick-row-tag">latest</span> : null}
                  <Check size={14} strokeWidth={2} aria-hidden className="tk-pick-check" data-on={selected || undefined} />
                </li>
              );
            })}
          </ul>

          {!tuned ? (
            <p className="tk-pick-note">
              No reasoning row: Lotus cannot turn effort into a flag for this agent. To pin a model, add it under Advanced → Extra flags.
            </p>
          ) : null}

          {tuned && tab === value.agent && efforts.length > 0 ? (
            <div className="tk-pick-effort-row">
              <div className="tk-pick-effort-head">
                <span className="tk-pick-section">Reasoning</span>
                <kbd className="tk-pick-keys" aria-hidden>
                  ← →
                </kbd>
              </div>
              <div className="tk-seg" role="radiogroup" aria-label="Reasoning">
                {[null, ...efforts].map((level) => (
                  <button
                    key={level ?? "default"}
                    type="button"
                    role="radio"
                    aria-checked={value.effort === level}
                    className="tk-seg-option"
                    onClick={() => onChange({ ...value, effort: level })}
                  >
                    {level ? effortLabel(level) : "Default"}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ProbeNote({ probe }: { probe?: AgentProbe }) {
  if (probe?.installed === undefined) return null;
  return (
    <span className="tk-pick-probe" data-ok={probe.installed || undefined}>
      <span className="tk-dot" aria-hidden />
      {probe.installed ? "installed" : "not found on PATH"}
    </span>
  );
}
