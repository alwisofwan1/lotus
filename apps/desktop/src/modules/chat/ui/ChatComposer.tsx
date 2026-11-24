"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { ArrowUp, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { ComposerStatus, SendMode, SentMessage } from "../domain/composer";
import type { Attachment } from "../domain/thread-event";
import type { Pick } from "../domain/preview";
import type { InteractionState } from "../domain/thread-state";
import type { ApprovalDecision, ChatThread, Runner } from "../runtime/chat-runtime-client";
import { AttachButton, AttachmentDrafts, AttachmentDrop } from "./ChatAttachments";
import { CHAT_FILE_DROP, CHAT_FILE_OVER } from "./file-drag";
import { PickChip } from "./ChatPreview";
import { QuoteCards } from "./ChatQuotes";
import type { Quote } from "../domain/quotes";
import { ChatRequest } from "./ChatRequest";
import { MentionPopover, useMentionPicker, type MentionChip } from "./ChatMention";
import { chatEditorExtensions, insertAtCaret as insertInto, paragraphs, textBeforeCaret } from "./chat-editor";
import { SkillChip, SlashPopover, useSlashPicker } from "./ChatSlash";
import { pastedFiles, useChatAttachments } from "./useChatAttachments";
import type { ChatFolderFiles } from "../view-model/useChatFiles";
import { useChatVoice } from "../view-model/useChatVoice";
import { readComposerDraft, writeComposerDraft } from "../domain/composer-draft";
import { ChatMicButton, ChatVoiceBar, ChatVoiceHeard, ChatVoicePolished, ChatVoiceUnder, micTitle } from "./ChatVoice";

const NO_FILES: readonly string[] = [];

// Mockup: mockups/lotus-chat.fig, page "04a Composer" (#274). Every label comes from thread state.
// mockups/chat-composer-states.html: the bar under the editor holds controls only. What is going on
// lives where it happens — a copy on its chip, the send mode on the button, a wait on one status line.
const MODE_LABELS: Record<Exclude<SendMode, "send">, { tag: string; hint: string; tray: string }> = {
  steer: { tag: "Steer", hint: "Read after the current step", tray: "after this step" },
  queue: { tag: "Queue", hint: "Read when this reply ends, or after its next step", tray: "after this reply" },
};

/** What a held message waits for, as the status line and the button's tooltip say it. */
const HELD_FOR = {
  copy: "when the attachments are copied",
  machine: "when the machine answers again",
} as const;

interface ChatComposerProps {
  threadId: string;
  /** Whose `/` commands and skills the picker lists. */
  runner?: Runner;
  status: ComposerStatus;
  /** Queued and steered messages not read yet; a plain send shows in the timeline instead. */
  unread: readonly (SentMessage & { mode: Exclude<SendMode, "send"> })[];
  /** The model picker, first in the bar under the editor. */
  model?: ReactNode;
  /** Permission mode and the like, shown beside it. */
  details: readonly string[];
  onSend: (text: string, attachments: Attachment[]) => Promise<void>;
  onStop: () => void;
  /** Requests the running turn waits on, oldest first; the composer shows the first. */
  waiting: readonly InteractionState[];
  cwd: string | null;
  onDecide: (interactionId: string, decision: ApprovalDecision) => Promise<void>;
  /** Text put in the editor from outside (a run's "Ask to fix"); `n` changes per fill. Not sent.
   *  `append` adds it after what is typed instead of replacing it; `attachments` are put back too. */
  fill?: { text: string; n: number; append?: boolean; attachments?: readonly Attachment[] } | null;
  /** Called once the fill is in the editor, so the owner drops it: kept, it came back on every
   *  remount (opening another chat and back), long after it was sent. */
  onFilled?: () => void;
  /** Elements picked in Preview; they go with the next message. */
  picks?: readonly Pick[];
  onRemovePick?: (id: string) => void;
  /** Passages quoted from the chat; they go with the next message. */
  quotes?: readonly Quote[];
  onRemoveQuote?: (id: string) => void;
  /** A Review note's card was clicked: open it in the diff. */
  onEditQuote?: (id: string) => void;
  /** Who answers: "Claude", "Codex", or the provider's name. */
  agentName?: string;
  /** The agent's plan line, at the top of the card. */
  plan?: ReactNode;
  /** The chat folder's files, offered by `@`. */
  folder?: ChatFolderFiles;
  /** Files this thread changed; a bare `@` offers them first. */
  changed?: ReadonlySet<string>;
  /** Chats `@` can name; this one is left out. */
  chats?: readonly ChatThread[];
  /** Chat is the mode on screen (not a pane in Code): the voice keys are this composer's. */
  voiceLive?: boolean;
  /** A remote chat whose machine is unreachable: typing stays, sending waits. */
  offline?: boolean;
  /** Why attachments cannot go with this chat; null = they can. */
  refuse?: string | null;
  /** The chat runs on another machine; attachments are copied there as they are added (ADR-0069). */
  remote?: boolean;
}

/**
 * Enter sends, Shift+Enter is a new line. Sending while a turn runs queues or steers it. While the
 * turn waits on a request, the request takes the top of the composer and sending is off: the text
 * becomes the note sent with Deny, or the user's own answer to a question.
 */
export function ChatComposer({ threadId, runner = "claude", status, unread, model, details, onSend, onStop, waiting, cwd, onDecide, fill, onFilled, picks = [], onRemovePick, quotes = [], onRemoveQuote, onEditQuote, plan, agentName = "Claude", folder, changed, chats, voiceLive = false, offline = false, refuse = null, remote = false }: ChatComposerProps) {
  // What was typed here before another chat was opened (or the app reloaded); read once per mount.
  const [saved] = useState(() => readComposerDraft(threadId));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const attach = useChatAttachments({ threadId, anchor: formRef, refuse, initial: saved?.attachments, remote: remote ? "now" : null });
  const { drafts, dropping: fileDropping } = attach;
  // A file dragged from the remote Files tab (file-drag.ts); the composer is its only target.
  const [fileOver, setFileOver] = useState(false);
  const dropping = fileDropping || fileOver;
  const { restore: attachRestore } = attach;
  useEffect(() => {
    const form = formRef.current;
    if (!form || !remote) return;
    const onOver = (event: Event) => setFileOver((event as CustomEvent<boolean>).detail);
    const onDrop = (event: Event) => attachRestore([(event as CustomEvent<Attachment>).detail]);
    form.addEventListener(CHAT_FILE_OVER, onOver);
    form.addEventListener(CHAT_FILE_DROP, onDrop);
    return () => {
      form.removeEventListener(CHAT_FILE_OVER, onOver);
      form.removeEventListener(CHAT_FILE_DROP, onDrop);
    };
  }, [remote, attachRestore]);
  const running = status.activity !== null;
  const request = waiting[0]?.interaction ?? null;
  const insertAtCaret = (text: string, typed: number, chip?: MentionChip) => insertInto(editor, text, typed, chip);
  const mention = useMentionPicker({ files: folder?.files ?? NO_FILES, truncated: folder?.truncated, changed, chats, current: threadId, cwd, enabled: !request && runner !== "api", onInsert: insertAtCaret });
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const slash = useSlashPicker({
    runner,
    cwd,
    enabled: !request,
    commands: true,
    onCommand: (name) => void send(`/${name}`),
    // Removes the typed `/query`, which is everything before the caret.
    onSkill: () => editor?.chain().deleteRange({ from: 1, to: editor.state.selection.from }).run(),
    onInsert: insertAtCaret,
    initialSkill: saved?.skill,
  });
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const placeholder = request
    ? `Add a note — ${agentName} gets it only if you Deny…`
    : slash.skill
      ? (slash.skill.argumentHint ?? "Add details, or send as is…")
      : running
        ? "Add to the running turn…"
        : quotes.length > 0
          ? "Ask about this…"
          : "Ask anything…";
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const submitRef = useRef<() => void>(() => {});

  const pasteRef = useRef(attach.paste);
  pasteRef.current = attach.paste;

  const [armed, setArmed] = useState<string | null>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  // Send was pressed while a copy ran or the machine was away: the message goes by itself once it can.
  const [held, setHeld] = useState(false);
  const heldRef = useRef(held);
  heldRef.current = held;
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  const removeQuoteRef = useRef(onRemoveQuote);
  removeQuoteRef.current = onRemoveQuote;

  const editor = useEditor({
    immediatelyRender: false,
    content: saved?.doc ?? undefined,
    extensions: chatEditorExtensions({ placeholder: () => placeholderRef.current, onEnter: () => submitRef.current() }),
    editorProps: {
      // Before the keymaps, so the picker takes Enter, Tab, arrows and Escape while it is open.
      handleKeyDown: (view, event) => {
        const picker = slashRef.current;
        if (event.isComposing || view.composing) return false;
        const { empty, from } = view.state.selection;
        if (event.key === "Backspace" && empty && from === 1 && picker.backspaceAtStart()) return true;
        // Backspace in an empty input marks the last quote, a second one removes it (like tags in Mail).
        const lastQuote = quotesRef.current.at(-1);
        if (event.key === "Backspace" && empty && from === 1 && view.state.doc.textContent === "" && lastQuote) {
          if (armedRef.current === lastQuote.id) removeQuoteRef.current?.(lastQuote.id);
          else setArmed(lastQuote.id);
          return true;
        }
        if (armedRef.current) setArmed(null);
        if (mentionRef.current.keyDown(event.key, event.shiftKey) || picker.keyDown(event.key, event.shiftKey)) {
          event.stopPropagation();
          return true;
        }
        if (event.key === "Escape" && heldRef.current) {
          setHeld(false);
          return true;
        }
        return false;
      },
      attributes: { class: "chat-composer-input", role: "textbox", "aria-label": "Message", "aria-multiline": "true" },
      handlePaste: (_view, event) => {
        const files = pastedFiles(event.clipboardData);
        if (files.length === 0) return false;
        void pasteRef.current(files);
        return true;
      },
    },
    onCreate: ({ editor: e }) => setText(e.getText({ blockSeparator: "\n" })),
    onUpdate: ({ editor: e }) => setText(e.getText({ blockSeparator: "\n" })),
    onTransaction: ({ editor: e }) => {
      const beforeCaret = textBeforeCaret(e);
      slashRef.current.track(beforeCaret);
      mentionRef.current.track(beforeCaret);
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    writeComposerDraft(threadId, { doc: editor.isEmpty ? null : editor.getJSON(), attachments: drafts.map((d) => d.attachment), skill: slash.skill });
  }, [editor, threadId, text, drafts, slash.skill]);

  // The cursor comes back here when nothing else holds it: on mount (the first message from Start
  // swaps in this editor, a thread switch mounts a new one) and after a send. WebKit leaves a clicked
  // button unfocused, so `body` means "nowhere"; a field or terminal the user picked keeps it.
  const reclaimFocus = () => {
    const active = document.activeElement;
    if (editor && !editor.isDestroyed && (!active || active === document.body)) editor.commands.focus("end");
  };
  const reclaimRef = useRef(reclaimFocus);
  reclaimRef.current = reclaimFocus;
  useEffect(() => reclaimRef.current(), [editor]);

  // The editor is a textbox that owns the picker's listbox; ProseMirror leaves these attributes alone.
  const { "aria-controls": controls, "aria-activedescendant": activeOption } = mention.open ? mention.inputAria : slash.inputAria;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    dom.setAttribute("aria-autocomplete", "list");
    for (const [name, value] of [["aria-controls", controls], ["aria-activedescendant", activeOption]] as const) {
      if (value) dom.setAttribute(name, value);
      else dom.removeAttribute(name);
    }
  }, [editor, controls, activeOption]);

  // The placeholder is a decoration; an empty transaction redraws it when the state changes.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder]);

  useEffect(() => {
    if (!fill || !editor || editor.isDestroyed) return;
    const content = paragraphs(fill.text);
    if (fill.append && !editor.isEmpty) editor.chain().focus("end").insertContent(content).run();
    else editor.chain().setContent({ type: "doc", content }, { emitUpdate: true }).focus("end").run();
  }, [editor, fill]);

  // A new quote means "now ask about it": the caret goes to the input.
  const quoteCount = useRef(quotes.length);
  useEffect(() => {
    if (quotes.length > quoteCount.current && editor && !editor.isDestroyed) editor.commands.focus("end");
    quoteCount.current = quotes.length;
  }, [editor, quotes.length]);

  const { restore } = attach;
  useEffect(() => {
    if (!fill || !editor || editor.isDestroyed) return;
    if (fill.attachments?.length) restore(fill.attachments);
    onFilled?.();
  }, [editor, fill, restore, onFilled]);

  const { blocked, copying } = attach;
  const hasContentWith = (typed: string) => typed.trim() !== "" || slash.skill !== null || drafts.length > 0 || picks.length > 0 || quotes.length > 0;
  const canSendWith = (typed: string) => hasContentWith(typed) && !blocked && !copying && !offline;
  const canSend = canSendWith(text);
  /** What a message sent now would have to wait for; null = nothing, it goes at once. */
  const waitsFor = copying ? "copy" : offline ? "machine" : null;
  const canHold = hasContentWith(text) && !blocked && waitsFor !== null;

  /** `command`: a picked `/clear` or `/compact`, sent alone. The typed `/query` goes; attachments stay. */
  const send = async (command?: string) => {
    // Read from the editor, not state: a dictated turn sent with ⌘Enter lands in the same tick.
    const typed = editor && !editor.isDestroyed ? editor.getText({ blockSeparator: "\n" }) : text;
    const message = command ?? slash.message(typed.trim());
    if (sending || request) return;
    // Not ready yet: hold it. The text stays editable and what is in the editor then is what goes.
    if (!command && !canSendWith(typed)) {
      if (hasContentWith(typed) && !blocked && waitsFor) setHeld(true);
      return;
    }
    setHeld(false);
    setSending(true);
    try {
      await onSend(message, command ? [] : attach.attachments);
      editor?.commands.clearContent(true);
      slash.clear();
      if (!command) attach.clear();
    } catch {
      // The page shows the error; the text stays so it can be sent again.
    } finally {
      setSending(false);
      reclaimFocus();
    }
  };
  submitRef.current = () => void send();

  // A held message goes once nothing holds it back; a copy that failed, or an emptied editor, drops the hold.
  const hasContent = hasContentWith(text);
  useEffect(() => {
    if (!held) return;
    if (blocked || !hasContent) return setHeld(false);
    if (!copying && !offline && !request && !sending) submitRef.current();
  }, [held, blocked, hasContent, copying, offline, request, sending]);

  const voice = useChatVoice({
    editor,
    thread: { id: threadId, name: agentName },
    live: voiceLive,
    send: () => {
      if (sending || request) return false;
      void send();
      return true;
    },
  });
  // A question carries its own answer box; the editor, and so the mic, step aside.
  const voiceOn = request?.kind !== "question";
  // Nothing in the composer at all: talking is the action, so the mic takes Send's place.
  const talkFirst = voiceOn && !running && !request && text.trim() === "" && !slash.skill && drafts.length === 0 && picks.length === 0 && quotes.length === 0;

  const decide = async (decision: ApprovalDecision) => {
    if (!request || sending) return;
    setSending(true);
    try {
      await onDecide(request.id, decision);
      editor?.commands.clearContent(true);
    } catch {
      // The page shows the error; the request stays so it can be decided again.
    } finally {
      setSending(false);
      reclaimFocus();
    }
  };

  const mode = status.mode === "send" ? null : MODE_LABELS[status.mode];
  const starting = sending && !running;
  // The button says the action it will take: a send during a turn steers or queues it.
  const label = mode && (canSend || canHold || held) ? mode.tag : null;
  /** Why the button shows a ring instead of its arrow. */
  const wait: "copy" | "machine" | "starting" | null = starting ? "starting" : canHold || held ? waitsFor : null;
  // The mode is the turn's when the message leaves, not when Send was pressed: the line follows it live.
  const heldLine = `Sends as ${mode ? mode.tag : "a new message"} ${HELD_FOR[waitsFor ?? "copy"]}`;
  const sendTitle = held
    ? `${heldLine} · click or Esc to cancel`
    : blocked
      ? "Remove the attachment marked in red to send"
      : starting
        ? `Starting ${agentName}…`
        : canHold
          ? waitsFor === "copy"
            ? "Still copying · press to send as soon as it is done"
            : "The machine is not answering · press to send when it is back"
          : (mode?.hint ?? undefined);

  return (
    <form
      ref={formRef}
      className="chat-composer"
      data-chat-file-drop={remote ? "" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div
        className="chat-composer-card"
        data-slash={slash.open || mention.open || undefined}
        data-running={running || undefined}
        data-waiting={request ? true : undefined}
        data-dropping={dropping || undefined}
      >
        <SlashPopover slash={slash} place="above" />
        <MentionPopover mention={mention} place="above" />
        {dropping && <AttachmentDrop />}
        {plan}
        {/* Working shows in the timeline; the strip is only for a turn blocked on the user. */}
        {running && request && (
          <div className="chat-composer-strip">
            <span className="chat-composer-dot" aria-hidden />
            <span className="chat-composer-strip-label">
              {request.kind === "question" ? request.questions[0]?.header || "Question" : "Waiting for you"}
            </span>
            <span className="chat-composer-strip-step">
              {`${request.kind === "question" ? (request.questions[0]?.header ? "· Question" : "") : request.toolName}${waiting.length > 1 ? ` · ${waiting.length} waiting` : ""}`}
            </span>
            <button type="button" className="chat-composer-stop" onClick={onStop}>
              <Square size={9} fill="currentColor" aria-hidden />
              Stop
            </button>
          </div>
        )}
        {unread.length > 0 && (
          <ul className="chat-composer-tray" aria-label="Sent, not read yet">
            {unread.map((m) => (
              <li key={m.clientRequestId} className="chat-composer-tray-row">
                <span className="chat-composer-tag" data-mode={m.mode}>
                  {MODE_LABELS[m.mode].tag}
                </span>
                <span className="chat-composer-tray-text">{m.text}</span>
                <span className="chat-composer-tray-when">{MODE_LABELS[m.mode].tray}</span>
              </li>
            ))}
          </ul>
        )}
        {request && (
          <ChatRequest
            interaction={request}
            count={waiting.length}
            cwd={cwd}
            text={text.trim()}
            busy={sending}
            onDecide={(decision) => void decide(decision)}
          />
        )}
        {request?.kind !== "question" && <QuoteCards quotes={quotes} armed={armed} onRemove={(id) => onRemoveQuote?.(id)} onEdit={onEditQuote} />}
        {picks.length > 0 && request?.kind !== "question" && (
          <ul className="chat-picks" aria-label="Picked on the page">
            {picks.map((p) => (
              <PickChip key={p.id} pick={p} onRemove={() => onRemovePick?.(p.id)} />
            ))}
          </ul>
        )}
        {request?.kind !== "question" && <AttachmentDrafts drafts={drafts} onRemove={attach.remove} />}
        {attach.error && (
          <p className="chat-composer-attach-error" role="alert">
            {attach.error}
          </p>
        )}
        {/* One line about a wait the user started; it never wraps, so nothing below it moves twice. */}
        {(starting || (held && waitsFor)) && !request && (
          <div className="chat-composer-status" role="status">
            <span className="chat-composer-spinner" aria-hidden />
            <span className="chat-composer-status-text">
              {starting ? `Starting ${agentName} · the first message takes a few seconds` : heldLine}
            </span>
            {held && (
              <button type="button" className="chat-composer-status-cancel" onClick={() => setHeld(false)} title="Esc">
                Cancel
              </button>
            )}
          </div>
        )}
        {/* A question carries its own answer box, so the editor steps aside while one is open. */}
        <div className="chat-composer-line" hidden={request?.kind === "question"} data-voice-over={voice.capturing && !text.trim() ? true : undefined}>
          <SkillChip slash={slash} />
          <EditorContent editor={editor} className="chat-composer-editor" />
        </div>
        {voiceOn && <ChatVoiceHeard voice={voice} />}
        {voiceOn && voice.capturing ? (
          <div className="chat-composer-foot">
            <ChatVoiceBar voice={voice} />
          </div>
        ) : (
        <div className="chat-composer-foot" hidden={request?.kind === "question"}>
          <AttachButton disabled={request !== null} onPick={attach.pick} />
          {model}
          {request ? null : voice.polished ? (
            <span className="chat-composer-hint">
              <ChatVoicePolished voice={voice} />
            </span>
          ) : (
            <span className="chat-composer-details" title="⏎ send · ⇧⏎ new line">
              {details.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
            </span>
          )}
          {/* Always mounted, so typing never moves anything: it only fades in once the main button is Send. */}
          {voiceOn && <ChatMicButton voice={voice} hidden={talkFirst} disabled={sending} />}
          {running && !request && !canSend && !canHold && !held ? (
            <button type="button" className="chat-composer-send" aria-label="Stop" onClick={onStop}>
              <Square size={11} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <>
              {/* Typing during a turn turns Send into Steer/Queue; Stop stays reachable beside it. */}
              {running && !request && (
                <button type="button" className="chat-composer-stop-mini" aria-label="Stop" onClick={onStop}>
                  <Square size={9} fill="currentColor" aria-hidden />
                </button>
              )}
              {/* One button, two faces: the mic while there is nothing to send, Send once there is. */}
              <button
                type={talkFirst || held ? "button" : "submit"}
                className="chat-composer-send"
                data-face={talkFirst ? "mic" : "send"}
                data-primary={talkFirst || undefined}
                data-unavailable={(talkFirst && !voice.available) || undefined}
                data-labelled={(!talkFirst && label !== null) || undefined}
                data-waiting={wait ?? undefined}
                data-held={held || undefined}
                aria-label={talkFirst ? "Dictate" : held ? "Cancel send" : starting ? "Starting" : (mode?.tag ?? "Send")}
                title={talkFirst ? micTitle(voice) : sendTitle}
                onClick={talkFirst ? () => voice.toggle() : held ? () => setHeld(false) : undefined}
                disabled={talkFirst ? sending : !(canSend || canHold || held) || sending || request !== null}
                style={wait === "copy" && attach.progress !== null ? ({ "--chat-send-progress": `${attach.progress}%` } as CSSProperties) : undefined}
              >
                <Mic size={16} strokeWidth={1.8} className="chat-send-face" data-face="mic" aria-hidden />
                <ArrowUp size={16} strokeWidth={2.4} className="chat-send-face" data-face="send" aria-hidden />
                {/* A copy fills the ring as it goes; a wait with no measure (starting, the machine away) spins it. */}
                <span className="chat-send-wait" data-measured={(wait === "copy" && attach.progress !== null) || undefined} aria-hidden />
                {label && <span className="chat-send-label">{label}</span>}
              </button>
            </>
          )}
        </div>
        )}
      </div>
      {voiceOn && <ChatVoiceUnder voice={voice} />}
    </form>
  );
}
