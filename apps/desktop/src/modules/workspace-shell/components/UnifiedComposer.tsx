"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Brain, ChevronDown, Paperclip, Pencil, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { detectCanvasHotkeyPlatform, formatChord } from "@/modules/codecanvas/services/canvas-hotkeys";
import "@/styles/composer-voice.css";
import { useElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import type { PaneActivity, PaneKind } from "@/modules/workspace-shell/types";
import {
  ComposerTargetLabel,
  HeldPromptNote,
  LiveVoiceControls,
  LiveVoiceStrip,
  LiveVoiceSummary,
  VoiceSlot,
  VoiceTimer,
  VoiceWave,
  useListeningRow,
  voiceStopHint,
  type ComposerLiveSession,
  type ComposerLiveVoice,
  type ComposerVoice,
} from "@/modules/workspace-shell/components/composer-voice-parts";
import { liveVoiceStatusText } from "@/modules/voice-core/live-voice-strip";
import { useLiveVoiceSession } from "@/modules/voice-core/use-live-voice-session";
import { CommandSheet, COMMAND_SHEET_LISTBOX_ID, commandRowId } from "@/modules/workspace-shell/components/CommandSheet";
import type { CommandSheetBinding } from "@/modules/workspace-shell/hooks/useCommandSheet";

interface UnifiedComposerProps {
  /**
   * The pane this text will reach. Naming it is the whole point of one composer. `locked` = the text
   * was spoken for this pane and focus has moved since: Enter still sends it here (ADR-0064).
   */
  target: { kind: PaneKind; label: string; activity?: PaneActivity; locked?: boolean } | null;
  placeholder: string;
  /**
   * Each control is hidden when its label is empty.
   *
   * A terminal has no model and no edit mode; showing those pickers over a shell would be three
   * buttons that mean nothing and do nothing. They belong to targets that actually have them.
   */
  model?: string;
  effort?: string;
  editMode?: string;
  tokens?: string;
  /** Chat has no focused pane to inherit context from, so it offers attachments instead. */
  showAttach?: boolean;
  className?: string;
  /** Sends the text to whatever `target` names. Absent means the composer is read-only. */
  onSubmit?: (text: string) => void | Promise<void>;
  /**
   * The agent, model and effort the focused pane is running.
   *
   * Absent for a pane that has none — a shell has no model, and a picker over it would be three
   * controls that mean nothing. `models` and `efforts` are what THIS model actually accepts, so
   * the menu cannot offer a combination the agent will reject.
   */
  agentPicker?: {
    agentLabel: string;
    modelLabel: string;
    effort: string;
    efforts: readonly string[];
    onEffortChange: (effort: string) => void;
  };
  /** Why sending is unavailable, shown in place of the placeholder. */
  disabledReason?: string;
  /**
   * The ⌘K command sheet, if this composer is the one that hosts it.
   *
   * Hosting it here rather than in a palette of its own is the decision: the shell already has the
   * place you type, and a second input that also takes text would be two boxes claiming the same
   * job. A leading `/` turns this field into a command line and back.
   */
  sheet?: CommandSheetBinding;
  /**
   * Push-to-Talk (Voice Core). Absent = no Dictate button. The mic stays beside the field whatever is
   * typed (speaking adds to it); it hides only while the command sheet is open. While the mic is open
   * the row becomes the listening row (cancel · target · live transcript · timer · stop) and the note
   * line says how this turn stops.
   */
  voice?: ComposerVoice;
  /** Live Voice, offered in the slot while the field is empty. */
  liveVoice?: ComposerLiveVoice;
  /**
   * The Live Voice session. While it runs the composer is its state (→ Lotus, status, End) with the
   * conversation strip above it; typed text is stashed and given back on End, and a summary line stays.
   */
  liveSession?: ComposerLiveSession;
  /**
   * Float over the panes instead of sitting under them. The dock keeps exactly the composer's
   * one-line height in the layout; a longer message grows the card UPWARD over the panes, so a
   * terminal never resizes (and reflows) because someone typed a paragraph.
   */
  floating?: boolean;
  /**
   * Text to add to the field, from outside (a spoken turn held for review). A new `seq` appends `text`
   * once; the field keeps whatever was already typed. `spoken` is set when `text` was cleaned up
   * automatically — the composer offers it back with Undo while the cleaned text is still there.
   */
  insert?: { text: string; seq: number; spoken?: string };
  /** One line under the field: an error, or why the text in it was not sent. */
  notice?: string | null;
  /** The message became empty (sent, cleared, deleted by hand) or got text. Text ⌘K holds aside
   *  still counts: Escape puts it back. */
  onEmptyChange?: (empty: boolean) => void;
  /**
   * A **Held Prompt**: spoken text waiting, unsent, in this agent's own prompt (ADR-0064). While the
   * field is empty Enter sends it; Escape clears it. Typing in the field leaves it alone. A new `seq`
   * gives the field focus, so those keys reach it. `cleaned` = the text was cleaned up by AI; there
   * is no Undo for it, the text is in the agent's prompt now. `joinsMessage` = a typed message goes to
   * that same agent, so Enter sends it after the held text, as one message.
   */
  /**
   * Drawn above the field: things that go with the message (Browser picks, as chips). `ready` = they
   * are a message by themselves, so Enter sends with the field empty.
   */
  extras?: { node: ReactNode; ready: boolean } | null;
  heldPrompt?: {
    label: string;
    seq: number;
    cleaned?: boolean;
    joinsMessage?: boolean;
    onSend: () => void;
    onClear: () => void;
  } | null;
}

export function UnifiedComposer({
  target,
  placeholder,
  model,
  effort,
  editMode,
  tokens,
  showAttach,
  className,
  onSubmit,
  disabledReason,
  agentPicker,
  sheet,
  voice,
  liveVoice,
  liveSession,
  insert,
  notice,
  floating,
  onEmptyChange,
  heldPrompt,
  extras,
}: UnifiedComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Re-renders on a width change so the auto-size below re-measures: a resize re-wraps the text.
  const [measureField] = useElementSize<HTMLTextAreaElement>();
  const setField = useCallback(
    (element: HTMLTextAreaElement | null) => {
      inputRef.current = element;
      measureField(element);
    },
    [measureField],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLParagraphElement>(null);
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  /** Lines a blurred floating composer is hiding — set on blur, read by the "+N lines" badge. */
  const [hiddenLines, setHiddenLines] = useState(0);
  const sheetOpen = Boolean(sheet?.open);
  // A command is not a message: while the sheet is open, Enter runs a row and the send button has
  // nothing to send.
  const canSend = Boolean(onSubmit) && !disabledReason && !sheetOpen && (value.trim().length > 0 || Boolean(extras?.ready));

  /*
    ⌘K takes the field over, and gives it back.

    The message someone had already typed is STASHED rather than thrown away: entering command
    mode must not be able to eat a half-written message, and Escape puts it back exactly as it
    was. The swap is adjusted DURING RENDER against the previous signal — React's own pattern for
    state that follows a changing input — because doing it from an effect renders one frame with
    the old text and trips the compiler's cascading-render rule. Only the focus call, which
    touches the DOM rather than state, belongs in the effect.
  */
  const focusSignal = sheet?.focusSignal ?? 0;
  const [lastFocusSignal, setLastFocusSignal] = useState(focusSignal);
  const [stashedMessage, setStashedMessage] = useState("");
  if (focusSignal !== lastFocusSignal) {
    setLastFocusSignal(focusSignal);
    setStashedMessage(value);
    setValue("");
  }
  // Reported on change only: the caller hears about the message, not about every keystroke.
  const messageEmpty = !value.trim() && !stashedMessage.trim();
  const wasEmptyRef = useRef(messageEmpty);
  useEffect(() => {
    if (messageEmpty === wasEmptyRef.current) return;
    wasEmptyRef.current = messageEmpty;
    onEmptyChange?.(messageEmpty);
  }, [messageEmpty, onEmptyChange]);
  useEffect(() => {
    if (focusSignal === 0) return;
    inputRef.current?.focus();
  }, [focusSignal]);

  /*
    A spoken turn held for review lands here, after whatever was already typed. Same
    adjust-during-render pattern as the ⌘K swap above; focusing is the effect's job.
  */
  const [cleanup, setCleanup] = useState<{ cleaned: string; spoken: string } | null>(null);
  const insertSeq = insert?.seq ?? 0;
  const [lastInsertSeq, setLastInsertSeq] = useState(insertSeq);
  if (insertSeq !== lastInsertSeq) {
    setLastInsertSeq(insertSeq);
    const added = insert?.text.trim() ?? "";
    if (added) setValue((current) => (current.trim() ? `${current.replace(/\s+$/, "")} ${added}` : added));
    const spoken = insert?.spoken?.trim();
    setCleanup(added && spoken && spoken !== added ? { cleaned: added, spoken } : null);
  }
  useEffect(() => {
    if (insertSeq === 0) return;
    inputRef.current?.focus();
  }, [insertSeq]);

  const heldPromptSeq = heldPrompt?.seq ?? 0;
  useEffect(() => {
    if (heldPromptSeq === 0) return;
    inputRef.current?.focus();
  }, [heldPromptSeq]);

  /* Undo stays on offer only while the cleaned text is still in the field, untouched. */
  const undoableCleanup = cleanup && value.includes(cleanup.cleaned) ? cleanup : null;
  function undoCleanup() {
    if (!undoableCleanup) return;
    const { cleaned, spoken } = undoableCleanup;
    setValue((current) => {
      const at = current.lastIndexOf(cleaned);
      return at < 0 ? current : `${current.slice(0, at)}${spoken}${current.slice(at + cleaned.length)}`;
    });
    setCleanup(null);
    inputRef.current?.focus();
  }

  /* Live Voice (ticket 10): the field is stashed while it runs, the way ⌘K stashes it. */
  const liveActive = Boolean(liveSession?.active);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  });
  const liveView = useLiveVoiceSession({
    active: liveActive,
    phase: liveSession?.phase ?? "idle",
    actions: liveSession?.strip.actions ?? 0,
    stash: { read: () => valueRef.current, write: setValue },
  });

  function send() {
    if (!canSend || !onSubmit) return;
    liveView.noteSend();
    const text = value;
    // Cleared before the send resolves: the message is the caller's problem now, and a box that
    // stays full while the text is already on its way invites sending it twice.
    setValue("");
    setCleanup(null);
    void onSubmit(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (sheet?.open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        sheet.onMove(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey && sheet.cycleActive()) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        sheet.close();
        setValue(stashedMessage);
        setStashedMessage("");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        // Falls through to sending only when there is nothing runnable — an unmatched query is
        // still text somebody typed.
        if (sheet.runActive()) {
          setValue("");
          setStashedMessage("");
        }
        return;
      }
    }
    if (heldPrompt && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        heldPrompt.onClear();
        return;
      }
      // Only an empty field: a message being typed is its own, and Enter sends that.
      if (event.key === "Enter" && !event.shiftKey && !value.trim()) {
        event.preventDefault();
        heldPrompt.onSend();
        return;
      }
    }
    // Enter sends, Shift+Enter breaks the line — the same contract as every composer in the app.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  /*
    The second row exists only when it carries something.

    A terminal has no model, no effort and no attachments, so over a shell that row was a spacer
    and two round buttons — a whole band of height for two controls, with the void the screenshot
    showed. The send and dictate buttons moved up beside the field, where they belong anyway:
    they act on what is being typed.
  */
  const hasControls = Boolean(showAttach || agentPicker || model || effort || editMode || tokens);

  const activeRowId = sheet?.open ? sheet.ranked.items[sheet.activeIndex]?.id : undefined;

  const voicePhase = voice?.phase ?? "idle";
  const { listening, settling, voiceRow, heard, waveInline, waveTrailing } = useListeningRow(voicePhase, voice?.interim ?? "", value);

  /*
    A pane that cannot take text used to replace the field with its reason. Text already in the field
    — a spoken turn kept for exactly that reason — must stay visible, so the field stays and the
    reason moves to the notice line.
  */
  const showField = !disabledReason || value.length > 0;
  const reason = notice ?? (disabledReason && showField ? disabledReason : null);
  const empty = value.trim().length === 0;
  // While listening the note line says how this turn stops; what it said before comes back after.
  // Recording only: while the mic is still opening, ⌘Enter has no turn to finish yet.
  const stopHint = voice && voicePhase === "recording" ? voiceStopHint(voice) : null;
  const platform = detectCanvasHotkeyPlatform();
  const sheetKey = formatChord("mod+k", platform).join(platform === "mac" ? "" : "+");
  const showSheetKey = Boolean(sheet) && !sheetOpen && empty && showField && !voiceRow;
  const collapsed = Boolean(floating) && !focused && hiddenLines > 0 && !voiceRow && !sheetOpen;

  /*
    Auto-size the field by hand: WKWebView has no `field-sizing: content`. Floating, the dock then
    keeps the composer's height as if the field were one line — everything above that line is the
    card growing over the panes, not the panes shrinking.
  */
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (field) {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }
    const root = rootRef.current;
    const dock = dockRef.current;
    if (!floating || !root || !dock) return;
    // Whichever line is growing: the field, or the live transcript that replaces it while listening.
    const grows = field ?? liveRef.current;
    const extra = grows ? Math.max(0, grows.offsetHeight - fieldMetrics(grows).oneLine) : 0;
    dock.style.height = `${Math.max(0, root.offsetHeight - extra)}px`;
  });

  const levelTarget = voice?.levelTarget;
  const setRoot = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      levelTarget?.(element);
    },
    [levelTarget],
  );

  function handleBlur() {
    setFocused(false);
    const field = inputRef.current;
    if (!floating || !field) return;
    const { line, padding } = fieldMetrics(field);
    setHiddenLines(Math.max(0, Math.round((field.scrollHeight - padding) / line) - 1));
  }

  const composer = (
    <div
      ref={setRoot}
      className={cn("ws-composer", className)}
      data-empty={hasControls ? undefined : "true"}
      data-voice={voicePhase === "idle" ? undefined : voicePhase}
      data-floating={floating ? "true" : undefined}
      data-collapsed={collapsed ? "true" : undefined}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    >
      <span className="ws-composer-edge" aria-hidden />
      {sheet?.open ? (
        <CommandSheet
          ranked={sheet.ranked}
          activeIndex={sheet.activeIndex}
          query={sheet.query}
          onHover={sheet.onHover}
          onRun={(index) => {
            sheet.run(index);
            setValue("");
            setStashedMessage("");
          }}
        />
      ) : null}
      {liveSession?.active ? (
        <LiveVoiceStrip turns={liveSession.strip.turns} provider={liveSession.providerName} startedAt={liveView.startedAt} />
      ) : null}
      {extras?.node}
      <div className="ws-composer-input">
        {voice?.onCancel && listening ? (
          <button
            type="button"
            className="ws-round-button"
            data-variant="cancel"
            aria-label="Cancel dictation"
            title="Cancel (Esc)"
            onClick={voice.onCancel}
          >
            <X size={15} strokeWidth={2} />
          </button>
        ) : null}
        <ComposerTargetLabel target={liveSession?.active ? { label: "Lotus" } : target} command={sheetOpen && !liveActive} />
        {liveSession?.active ? (
          <p className="ws-composer-live" data-live-voice={liveSession.phase === "error" ? "error" : "true"} role="status" aria-live="polite">
            {liveVoiceStatusText({ phase: liveSession.phase, agentSpeaking: liveSession.agentSpeaking, error: liveSession.error })}
          </p>
        ) : voiceRow ? (
          <p ref={liveRef} className="ws-composer-live" data-settling={settling ? "true" : undefined} aria-live="polite">
            {value.trim() ? <span className="ws-composer-live-typed">{value.trim()} </span> : null}
            {heard ? (
              <span className="ws-composer-live-heard">{heard}</span>
            ) : waveInline ? (
              <>
                <VoiceWave />
                <span className="sr-only">Listening…</span>
              </>
            ) : (
              <span className="ws-composer-live-hint">
                {voicePhase === "starting" ? "Opening the mic…" : settling ? "Transcribing…" : "Listening…"}
              </span>
            )}
          </p>
        ) : null}
        {voiceRow || liveActive ? null : !showField ? (
          <span className="ws-composer-placeholder">{disabledReason}</span>
        ) : (
          <textarea
            ref={setField}
            className="ws-composer-field"
            rows={1}
            value={value}
            placeholder={sheetOpen ? "Search agents, panes, workspaces…" : placeholder}
            readOnly={!onSubmit}
            onChange={(event) => {
              setValue(event.target.value);
              sheet?.onInput(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            data-collapsed={collapsed ? "true" : undefined}
            aria-label={target ? `Send to ${target.label}` : "Write a message"}
            /* A combobox whose listbox is the sheet above it: focus stays here, which is what
               makes the sheet a list rather than a dialog. */
            role={sheet ? "combobox" : undefined}
            aria-expanded={sheet ? sheet.open : undefined}
            aria-controls={sheet?.open ? COMMAND_SHEET_LISTBOX_ID : undefined}
            aria-activedescendant={activeRowId ? commandRowId(activeRowId) : undefined}
          />
        )}
        <span className="ws-composer-actions">
          {collapsed ? <span className="ws-composer-more">+{hiddenLines} lines</span> : null}
          {showSheetKey ? (
            <kbd className="ws-composer-kbd" title="Commands">
              {sheetKey}
            </kbd>
          ) : null}
          {waveTrailing ? <VoiceWave settled={settling} /> : null}
          {listening ? <VoiceTimer /> : null}
          {liveSession?.active ? (
            <LiveVoiceControls
              phase={liveSession.phase}
              agentSpeaking={liveSession.agentSpeaking}
              onEnd={liveSession.onEnd}
              onRetry={liveSession.onRetry}
              micMuted={liveSession.micMuted}
              onToggleMic={liveSession.onToggleMic}
            />
          ) : (
            <VoiceSlot voice={voice} liveVoice={liveVoice} empty={empty && !extras?.ready} sheetOpen={sheetOpen} canSend={canSend} onSend={send} />
          )}
        </span>
      </div>
      {!liveActive && (stopHint || reason || undoableCleanup || heldPrompt) ? (
        /* One quiet line for everything the composer has to say, never a stack of them. */
        <p className="ws-composer-note" role="status">
          {stopHint}
          {stopHint && reason ? " · " : null}
          {reason}
          {(stopHint || reason) && !listening && (undoableCleanup || heldPrompt) ? " · " : null}
          {heldPrompt && !listening ? (
            <>
              <HeldPromptNote label={heldPrompt.label} cleaned={heldPrompt.cleaned} empty={empty} joinsMessage={heldPrompt.joinsMessage} />
              {undoableCleanup ? " · " : null}
            </>
          ) : null}
          {undoableCleanup && !listening ? (
            <>
              Cleaned up by AI ·{" "}
              <button type="button" className="ws-composer-note-action" onClick={undoCleanup}>
                Undo
              </button>
              {canSend ? " · Enter to send" : null}
            </>
          ) : null}
        </p>
      ) : null}
      {liveView.summary && !liveActive ? <LiveVoiceSummary text={liveView.summary} onDismiss={liveView.dismissSummary} /> : null}
      {hasControls ? (
        <div className="ws-composer-controls">
          {showAttach ? (
            <button type="button" className="ws-control">
              <Paperclip size={14} strokeWidth={1.75} />
              Attach
            </button>
          ) : null}
          {agentPicker ? (
            <>
              <span className="ws-control" title={`${agentPicker.agentLabel} · ${agentPicker.modelLabel}`}>
                <Sparkles size={14} strokeWidth={1.75} />
                {agentPicker.agentLabel} · {agentPicker.modelLabel}
              </span>
              {agentPicker.efforts.length > 0 ? (
                <label className="ws-control">
                  <Brain size={14} strokeWidth={1.75} />
                  <select
                    className="ws-control-select"
                    value={agentPicker.effort}
                    onChange={(event) => agentPicker.onEffortChange(event.target.value)}
                    aria-label="Reasoning effort"
                  >
                    {agentPicker.efforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
          {model ? (
            <button type="button" className="ws-control">
              <Sparkles size={14} strokeWidth={1.75} />
              {model}
              <ChevronDown size={12} strokeWidth={1.75} />
            </button>
          ) : null}
          {effort ? (
            <button type="button" className="ws-control">
              <Brain size={14} strokeWidth={1.75} />
              {effort}
              <ChevronDown size={12} strokeWidth={1.75} />
            </button>
          ) : null}
          {editMode ? (
            <button type="button" className="ws-control">
              <Pencil size={14} strokeWidth={1.75} />
              {editMode}
              <ChevronDown size={12} strokeWidth={1.75} />
            </button>
          ) : null}
          <span className="ws-composer-spacer" />
          {tokens ? <span className="ws-pane-meta">{tokens}</span> : null}
        </div>
      ) : null}
    </div>
  );

  if (!floating) return composer;
  return (
    <div ref={dockRef} className="ws-composer-dock">
      {composer}
    </div>
  );
}

/** One text line of the field, its vertical padding, and the two together (its one-line height). */
function fieldMetrics(element: HTMLElement): { line: number; padding: number; oneLine: number } {
  const style = getComputedStyle(element);
  const parsed = Number.parseFloat(style.lineHeight);
  const line = Number.isFinite(parsed) && parsed > 0 ? parsed : 21;
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  return { line, padding, oneLine: line + padding };
}
