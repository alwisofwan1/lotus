"use client";

import { Check, ChevronDown, MessageSquarePlus, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { findSpec } from "@/modules/codespace/services/bridge/agent-registry";
import { ACP_AGENTS } from "../providers/acp/agents";
import { listChatModels, type ChatModel, type Runner } from "../runtime/chat-runtime-client";

// Mockup: mockups/lotus-chat.fig, page "04d Model picker" (#278), "06a Codex" (#286), "06b Rail"
// (#287: runner tabs), "06e API providers" (#288: the API tab). The list is the runner's own (Claude's for the current sign-in, or Codex's),
// like bb's provider model list; Lotus's model catalog is not consulted.

// Tab order: Claude, Codex, then the ACP agents in agents.json order, then API.
export const AGENT_NAMES = {
  claude: "Claude",
  codex: "Codex",
  ...Object.fromEntries(ACP_AGENTS.map((a) => [a.id, a.label])),
  api: "API",
} as Record<Runner, string>;
// No one logo stands for every API provider: a cloud (lucide's), drawn as a mask like the others.
const CLOUD =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
  );
const logoOf = (runner: Runner) => (runner === "api" ? CLOUD : findSpec(runner)?.logo ?? CLOUD);

/** The runner's mark, painted in `currentColor` through its logo, as the pane headers do. */
export function RunnerMark({ runner }: { runner: Runner }) {
  return <span aria-hidden className="chat-mark" data-runner={runner} style={{ ["--chat-mark" as string]: `url("${logoOf(runner)}")` }} />;
}

export interface ModelOption {
  model: ChatModel;
  /** The entry Claude's "default" resolves to. */
  isDefault: boolean;
  /** First of the pinned versions after the aliases; a divider goes above it. */
  startsOlder: boolean;
}

/** The rows to show: the "default" entry is folded into the model it resolves to. */
export function modelOptions(models: readonly ChatModel[]): ModelOption[] {
  // API models (#288) come from several providers, grouped by provider instead of by age.
  if (models.some((m) => m.provider)) return models.map((model) => ({ model, isDefault: model.isDefault === true, startsOlder: false }));
  const defaultTarget = models.find((m) => m.value === "default")?.resolvedModel;
  let defaultTaken = false;
  let olderSeen = false;
  return models
    .filter((m) => m.value !== "default")
    .map((model) => {
      const isDefault = !defaultTaken && (model.isDefault === true || (defaultTarget !== undefined && model.resolvedModel === defaultTarget));
      if (isDefault) defaultTaken = true;
      const older = model.value.startsWith("claude-");
      const startsOlder = older && !olderSeen;
      if (older) olderSeen = true;
      return { model, isDefault, startsOlder };
    });
}

/** The option a thread's model id is: picked by alias or reported resolved; null = Claude's default. */
export function currentOption(options: readonly ModelOption[], id: string | null, provider: string | null = null): ModelOption | null {
  if (provider) options = options.filter((o) => o.model.provider === provider);
  if (id === null || id === "default") return options.find((o) => o.isDefault) ?? null;
  return (
    options.find((o) => o.model.value === id) ??
    options.find((o) => o.model.resolvedModel === id) ??
    null
  );
}

/** A thread's model as people say it: from Claude's list, else "claude-opus-5-5" → "Opus 5.5". */
export function modelName(models: readonly ChatModel[], id: string | null | undefined): string | null {
  if (!id) return null;
  const option = currentOption(modelOptions(models), id);
  if (option) return option.model.displayName;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}

/** "xhigh" → "XHigh", "medium" → "Medium". */
export function effortName(effort: string): string {
  return effort === "xhigh" ? "XHigh" : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`;
}

// One list per runner, kept until Settings › Chat › Accounts changes a sign-in or a provider.
const cached = new Map<Runner, Promise<ChatModel[]>>();
let generation = 0;
const listeners = new Set<() => void>();

/** Drops every cached list; open pickers ask again. */
export function forgetChatModels() {
  cached.clear();
  generation += 1;
  for (const listener of listeners) listener();
}

/** `null`: no list wanted (a picker not browsing a handoff). */
export function useChatModels(runner: Runner | null): { models: ChatModel[]; error: string | null } {
  const [state, setState] = useState<{ runner: Runner | null; models: ChatModel[]; error: string | null } | null>(null);
  const [asked, setAsked] = useState(generation);
  useEffect(() => {
    const listener = () => setAsked(generation);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (runner === null) return;
    let live = true;
    let list = cached.get(runner);
    if (!list) {
      list = listChatModels(runner);
      cached.set(runner, list);
    }
    list.then(
      (models) => live && setState({ runner, models, error: null }),
      (reason: unknown) => {
        cached.delete(runner);
        if (live) setState({ runner, models: [], error: reason instanceof Error ? reason.message : String(reason) });
      },
    );
    return () => {
      live = false;
    };
  }, [runner, asked]);
  // Another runner's list never shows while this one loads.
  return state?.runner === runner ? { models: state.models, error: state.error } : { models: [], error: null };
}

/** Closes an open popover on a click outside `ref` or on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && closeRef.current();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);
}

const ALL_RUNNERS = Object.keys(AGENT_NAMES) as Runner[];
// bb shows search once the list is longer than this.
const SEARCH_FROM = 6;

/** A handoff pick: the agent and model the new chat starts on. */
export interface HandoffPick {
  runner: Runner;
  model: string;
  label: string;
  effort?: string;
  provider?: string;
}

interface ChatModelPickerProps {
  models: readonly ChatModel[];
  error: string | null;
  /** The thread's model: what was picked, or what the agent reported; null before either. */
  current: string | null;
  /** Codex's reasoning effort for the thread; null = the model's default. */
  effort?: string | null;
  /** Whose list it is: tabs on top. */
  runner: Runner;
  /** Switches runner; a new chat only. */
  onRunner?: (runner: Runner) => void;
  /** "link": a phrase in the start screen's sentence, opening downward. */
  variant?: "chip" | "link";
  /** "api": the picked model's provider. A thread's picker lists only that provider's models. */
  provider?: string | null;
  /** The tabs to offer; Smart Convert runs a CLI, so it leaves out "api". */
  runners?: readonly Runner[];
  /** A running chat: what its agent signed in with (see `accountLine`); shown only when it is not what was asked for. */
  account?: { label: string; mismatch: boolean } | null;
  /** Opens Settings › Chat › Accounts. */
  onManage?: () => void;
  /** A running chat: another agent's tab, then a model, continues it in a new chat (bb's handoff). */
  onHandoff?: (pick: HandoffPick) => void;
  onPick: (model: string, label: string, effort?: string, provider?: string) => Promise<void>;
  /** Opens downward, for a chip near the top of its surface (as `ChatAccountPicker`'s `below`). */
  below?: boolean;
}

// Laid out like bb's ModelReasoningPicker: icon tabs, search, "Model", "Reasoning", then the
// handoff action. In a running chat another agent's tab browses its models for a handoff.
export function ChatModelPicker({ models, error, current, effort = null, runner, onRunner, variant = "chip", provider = null, runners = ALL_RUNNERS, account = null, onManage, onHandoff, onPick, below = false }: ChatModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  /** The agent whose models a handoff is browsing; null = this chat's own list. */
  const [browse, setBrowse] = useState<Runner | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const browsed = useChatModels(browse);
  const own = modelOptions(onRunner || !provider ? models : models.filter((m) => m.provider === provider));
  const options = browse ? modelOptions(browsed.models) : own;
  const selected = currentOption(own, current, provider);
  const agent = (runner === "api" && selected?.model.providerName) || AGENT_NAMES[runner];
  const efforts = selected?.model.efforts ?? [];
  const shownEffort = effort ?? selected?.model.defaultEffort ?? null;
  const needle = query.trim().toLowerCase();
  const shown = needle ? options.filter((o) => `${o.model.displayName} ${o.model.value}`.toLowerCase().includes(needle)) : options;
  const listError = browse ? browsed.error : error;
  const tabRunner = browse ?? runner;

  const close = () => {
    setOpen(false);
    setQuery("");
    setBrowse(null);
  };
  useDismiss(ref, open, close);

  // A fixed max-height let the menu run past the window edge, cutting off Reasoning; size it to
  // the room actually left so the model list (flex: 1) shrinks and Reasoning stays in view.
  const [room, setRoom] = useState<number | null>(null);
  const down = variant === "link" || below;
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setRoom(Math.floor(down ? window.innerHeight - rect.bottom - 20 : rect.top - 20));
  }, [open, down]);

  const pick = async (option: ModelOption, nextEffort?: string) => {
    if (browse && onHandoff) {
      close();
      const { value, displayName, provider: from, defaultEffort } = option.model;
      onHandoff({ runner: browse, model: value, label: displayName, effort: defaultEffort ?? undefined, provider: from ?? undefined });
      return;
    }
    if (!nextEffort) close();
    if (option === selected && (!nextEffort || nextEffort === shownEffort)) return;
    // A model that cannot take the current effort starts on its own default.
    const keep = shownEffort && option.model.efforts?.includes(shownEffort) ? shownEffort : undefined;
    const chosen = nextEffort ?? (option.model.efforts?.length ? keep : undefined);
    const label = chosen ? `${option.model.displayName} · ${effortName(chosen)}` : option.model.displayName;
    setBusy(true);
    try {
      await onPick(option.model.value, label, chosen, option.model.provider);
    } finally {
      setBusy(false);
    }
  };

  const pickTab = (r: Runner) => {
    setQuery("");
    if (onRunner) {
      if (r !== runner) onRunner(r);
    } else if (onHandoff) setBrowse(r === runner && !browse ? null : r);
  };

  const name = selected?.model.displayName ?? modelName(models, current) ?? "Model";
  const shownEffortName = efforts.length > 0 && shownEffort ? effortName(shownEffort) : null;
  const tabs = onRunner || onHandoff;

  return (
    <div ref={ref} className="chat-model-anchor" data-variant={variant} data-placement={below ? "below" : undefined}>
      {variant === "link" ? (
        <button type="button" className="chat-sentence-link" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
          <RunnerMark runner={runner} />
          {runner === "api" ? name : `${agent} ${name}`}
          {shownEffortName && `, ${shownEffortName.toLowerCase()}`}
        </button>
      ) : (
        <button
          type="button"
          className="chat-model"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={busy}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <RunnerMark runner={runner} />
          <span className="chat-model-label">{name}</span>
          {shownEffortName && <span className="chat-model-effort">{shownEffortName}</span>}
          <ChevronDown size={12} aria-hidden />
        </button>
      )}
      {open && (
        <div className="chat-model-pop chat-model-menu" role="dialog" aria-label="Model" style={room ? ({ "--chat-model-room": `${room}px` } as CSSProperties) : undefined}>
          {browse && (
            <div className="chat-model-handoff-head">
              <button type="button" className="chat-model-icon-btn" aria-label="Exit handoff" onClick={() => setBrowse(null)}>
                <X size={14} aria-hidden />
              </button>
              <span>Handoff to new chat</span>
            </div>
          )}
          {tabs && (
            <div className="chat-model-tabs" role="group" aria-label="Agent">
              {runners.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="chat-model-tab"
                  aria-label={AGENT_NAMES[r]}
                  title={browse && r === runner ? `${AGENT_NAMES[r]} (this chat)` : AGENT_NAMES[r]}
                  aria-pressed={r === tabRunner}
                  onClick={() => pickTab(r)}
                >
                  <RunnerMark runner={r} />
                </button>
              ))}
            </div>
          )}
          {options.length >= SEARCH_FROM && (
            <label className="chat-model-search">
              <Search size={15} aria-hidden />
              <input autoFocus placeholder="Search models" aria-label="Search models" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
          )}
          <div className="chat-model-list">
            {options.length > 0 && <span className="chat-model-section">Model</span>}
            {options.length === 0 && (
              <p className="chat-model-pop-foot">
                {listError ?? (tabRunner === "api" ? "No API provider yet. Add one in Settings › Chat › Accounts." : `Asking ${AGENT_NAMES[tabRunner]} for its models…`)}
              </p>
            )}
            {needle && shown.length === 0 && <p className="chat-model-pop-foot">No models match your search</p>}
            {shown.map((option, i) => (
              <div key={`${option.model.provider ?? ""}:${option.model.value}`} className="chat-model-group">
                {option.model.providerName && option.model.provider !== shown[i - 1]?.model.provider && (
                  <span className="chat-model-section">{option.model.providerName}</span>
                )}
                <button
                  type="button"
                  className="chat-model-option"
                  title={option.model.description || undefined}
                  aria-pressed={!browse && option === selected}
                  onClick={() => void pick(option)}
                >
                  <span className="chat-model-option-label">{option.model.displayName}</span>
                  {!browse && option === selected && <Check className="chat-model-check" size={14} aria-hidden />}
                </button>
              </div>
            ))}
          </div>
          {!browse && selected && efforts.length > 0 && (
            <div className="chat-model-block">
              <span className="chat-model-section">Reasoning</span>
              <div className="chat-model-efforts" role="group" aria-label="Reasoning">
                {efforts.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className="chat-model-effort-option"
                    aria-pressed={e === shownEffort}
                    disabled={busy}
                    onClick={() => void pick(selected, e)}
                  >
                    {effortName(e)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!browse && account?.mismatch && (
            <p className="chat-model-block chat-model-account" data-mismatch>
              <span>{account.label}</span>
              {onManage && (
                <button
                  type="button"
                  className="chat-model-manage"
                  onClick={() => {
                    close();
                    onManage();
                  }}
                >
                  Manage
                </button>
              )}
            </p>
          )}
          {!browse && onHandoff && !onRunner && (
            <div className="chat-model-block">
              <button type="button" className="chat-model-option" onClick={() => setBrowse(runner)}>
                <MessageSquarePlus size={15} aria-hidden />
                <span className="chat-model-option-label">Handoff to new chat</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
