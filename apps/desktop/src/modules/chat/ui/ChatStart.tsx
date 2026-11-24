"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { ArrowUp, Check, ChevronDown, ChevronsUpDown, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { PERMISSION_MODES, permissionLabel } from "../domain/permissions";
import { folderName, QUOTES } from "../domain/rail";
import type { Attachment } from "../domain/thread-event";
import type { ChatThread, PermissionMode, Runner } from "../runtime/chat-runtime-client";
import { AttachButton, AttachmentDrafts, AttachmentDrop } from "./ChatAttachments";
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from "../domain/composer-draft";
import { AGENT_NAMES, ChatModelPicker, useChatModels, useDismiss } from "./ChatModel";
import { useChatFiles } from "../view-model/useChatFiles";
import { MentionPopover, useMentionPicker } from "./ChatMention";
import { chatEditorExtensions, insertAtCaret, paragraphs, textBeforeCaret } from "./chat-editor";
import { ChatMicButton, ChatVoiceBar, ChatVoiceHeard, ChatVoicePolished, ChatVoiceUnder } from "./ChatVoice";
import { useChatVoice } from "../view-model/useChatVoice";
import { SkillChip, SlashPopover, useSlashPicker } from "./ChatSlash";
import { Dither, DitherTile } from "./Dither";
import { ChatFolderPlaces, type PickedMachine } from "./ChatMachines";
import { pastedFiles, useChatAttachments } from "./useChatAttachments";

// Mockup: mockups/lotus-chat.fig, pages "06c New chat · Compare" (version C) and "06d New chat ·
// Dither" (04 Topography), "06e API providers" (#288). Nothing to set before typing; each choice
// is a phrase in the sentence. An API model touches no files, so it has no folder or mode.

export interface Draft {
  runner: Runner;
  /** Null: the runner's own default. */
  model: string | null;
  /** "api": the model's provider in Settings › Chat › Accounts. */
  provider: string | null;
  effort: string | null;
  cwd: string;
  permissionMode: PermissionMode;
  /** Runs in this machine's Lotus Host; `cwd` is then the project's path there. Null = this Mac. */
  machine?: PickedMachine | null;
}

/** The composer's permission switch in an open chat; same look as the account picker. */
export function ChatPermissionPicker({
  current,
  disabled,
  onPick,
}: {
  current: PermissionMode;
  disabled: boolean;
  onPick: (mode: PermissionMode, label: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const label = permissionLabel(current);

  const pick = async (mode: PermissionMode, picked: string) => {
    setOpen(false);
    if (mode === current) return;
    setBusy(true);
    try {
      await onPick(mode, picked);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="chat-model-anchor">
      <button
        type="button"
        className="chat-model"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Permissions: ${label}`}
        title={disabled ? "Wait for the reply to finish" : "What the agent may do without asking"}
        disabled={busy || disabled}
        onClick={() => setOpen(!open)}
      >
        <PermissionGlyph mode={current} />
        <span className="chat-model-label">{label}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div className="chat-model-pop chat-perm-pop" role="dialog" aria-label="Permissions">
          <PermissionList current={current} onPick={(mode, picked) => void pick(mode, picked)} foot="Applies from your next message." />
        </div>
      )}
    </div>
  );
}

// Each mode lights 4 more pixels: the more lit, the more the agent may do.
const LEVEL: Record<string, number> = { plan: 1, default: 2, acceptEdits: 3, bypassPermissions: 4 };

/** The permission mode as a small dither tile. */
function PermissionGlyph({ mode }: { mode: string }) {
  return <DitherTile lit={(LEVEL[mode] ?? 0) * 4} data-mode={mode} />;
}

/** The four modes, label over hint; the open chat's picker and the Chat home share it. */
function PermissionList({ current, onPick, foot }: { current: string; onPick: (mode: PermissionMode, label: string) => void; foot: string }) {
  return (
    <>
      {PERMISSION_MODES.map((m) => (
        <button key={m.mode} type="button" className="chat-perm-option" data-mode={m.mode} aria-pressed={m.mode === current} onClick={() => onPick(m.mode, m.label)}>
          <PermissionGlyph mode={m.mode} />
          <span className="chat-perm-label">{m.label}</span>
          <Check className="chat-perm-check" size={14} aria-hidden />
          <span className="chat-perm-hint">{m.detail}</span>
        </button>
      ))}
      <p className="chat-perm-foot">{foot}</p>
    </>
  );
}

/** "/Users/me/work/app" → "~/work": the folder a recent folder sits in, short enough for one line. */
const parentPath = (path: string) => path.slice(0, path.lastIndexOf("/")).replace(/^\/(?:Users|home)\/[^/]+/, "~") || "/";

const DRAFT_KEY = "lotus.chat.new";
const BLANK: Draft = { runner: "claude", model: null, provider: null, effort: null, cwd: "", permissionMode: "default", machine: null };
const RUNNERS = Object.keys(AGENT_NAMES) as Runner[];

export function loadDraft(): Draft {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Partial<Draft> | null;
    return { ...BLANK, ...saved, runner: RUNNERS.find((r) => r === saved?.runner) ?? "claude" };
  } catch {
    return BLANK;
  }
}

/** A Code pane's start (07d): in its folder, and never on a remembered API pick, which reads no
 *  files and would land the chat outside the workspace. Picking API there stays possible. */
export function draftInFolder(draft: Draft, cwd: string): Draft {
  return draft.runner === "api" ? { ...BLANK, permissionMode: draft.permissionMode, cwd } : { ...draft, cwd, machine: null };
}

function saveDraft(draft: Draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Remembering the last picks is a convenience only.
  }
}

/** 0–1, wrapping: `x % 1` for negative numbers too. */
const frac = (x: number) => x - Math.floor(x);

/** Topography: contour lines of a soft hill across the whole band. The fade upward is a CSS mask. */
function topography(u: number, v: number): number {
  const h = 0.55 * Math.sin(u * 5.2 + Math.sin(v * 2.4) * 1.3) + v * 1.6 + 0.35 * Math.cos(u * 2.1 - v);
  return Math.abs(frac(h * 5) - 0.5) < 0.09 ? 0.9 : 0;
}

interface ChatStartProps {
  /** Folders of earlier chats, newest first. */
  recent: readonly string[];
  /** The "Today" line; null before the first turn of the day. */
  stats: string | null;
  /** Creates the chat and sends `text` with `attachments`; rejects with the reason it could not. */
  /** `id` is the chat to create: pasted files are already saved under it. */
  onStart: (draft: Draft, text: string, attachments: Attachment[], id: string) => Promise<void>;
  /** A Code pane's folder (07d): kept, not picked, and not remembered as the last pick. */
  cwd?: string;
  /** Text put into the task box from outside (⌘L), appended; `n` makes a repeat a new fill. */
  fill?: { text: string; n: number } | null;
  /** Called once the fill is in the task box, so the owner drops it instead of refilling on remount. */
  onFilled?: () => void;
  /** Chats `@` can name. */
  chats?: readonly ChatThread[];
  /** Chat is the mode on screen (not a pane in Code): the voice keys are this box's. */
  voiceLive?: boolean;
}

const noSubscribe = () => () => {};

/** The API runner sends text only (#288); its bridge refuses attachments. */
export const TEXT_ONLY = "API chats take text only";
/** Only these runners run in a Lotus Host. */
const runsRemote = (runner: Runner) => runner === "claude" || runner === "codex";

export function ChatStart({ recent, stats, onStart, cwd: fixedCwd, fill, onFilled, chats, voiceLive = false }: ChatStartProps) {
  // The server cannot know the random quote or the saved picks; rendering them in the hydration
  // pass would mismatch and make React re-render the whole page on the client. They show right after.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [saved] = useState(loadDraft);
  const [picked, setPicked] = useState<Draft | null>(null);
  const remembered = hydrated ? saved : BLANK;
  const draft = fixedCwd
    ? picked ? { ...picked, cwd: fixedCwd } : draftInFolder(remembered, fixedCwd)
    : (picked ?? remembered);
  const [quoteIndex] = useState(() => Math.floor(Math.random() * QUOTES.length));
  const quote = QUOTES[hydrated ? quoteIndex : 0];
  // Typed but not started yet: kept across opening a chat and coming back, and across a reload.
  const draftKey = `start:${fixedCwd ?? "home"}`;
  const [typed] = useState(() => readComposerDraft(draftKey));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = useChatModels(draft.runner);
  const set = (patch: Partial<Draft>) =>
    setPicked((d) => {
      const next = { ...(d ?? (fixedCwd ? draftInFolder(saved, fixedCwd) : saved)), ...patch };
      // A pane's folder is not the user's last pick of folder.
      saveDraft(fixedCwd ? { ...next, cwd: saved.cwd } : next);
      return next;
    });
  const folders = [...new Set([draft.machine ? "" : draft.cwd, ...recent].filter(Boolean))].slice(0, 6);
  const mode = PERMISSION_MODES.find((m) => m.mode === draft.permissionMode) ?? PERMISSION_MODES[1];

  const api = draft.runner === "api";
  const remote = draft.machine ?? null;
  const refuse = api ? TEXT_ONLY : null;
  // No model picked yet: the first provider's default, as the picker shows it.
  const apiDefault = models.models.find((m) => m.isDefault) ?? models.models[0];

  const formRef = useRef<HTMLFormElement>(null);
  // No thread yet: pasted files are kept under the id the chat will be created with.
  const [stagingId] = useState(() => crypto.randomUUID());
  const focusAfterDrop = useRef<() => void>(() => {});
  const attach = useChatAttachments({ threadId: stagingId, anchor: formRef, refuse, onDropAccepted: () => focusAfterDrop.current(), initial: typed?.attachments, remote: remote ? "on-send" : null });
  const textOnly = refuse !== null && attach.drafts.length > 0;
  const blocked = attach.blocked || textOnly;
  const notice = error ?? attach.error ?? (textOnly ? `${refuse} · remove the attachments` : attach.blocked ? "Remove what cannot be sent" : null);

  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const lines = text.split("\n").length;
  // Skills only: a new chat has no context to clear. A pick drops the typed `/query`.
  const slash = useSlashPicker({
    runner: draft.runner,
    // A remote project's path is not on this Mac.
    cwd: remote ? null : draft.cwd || null,
    enabled: !busy,
    commands: false,
    onCommand: () => {},
    onSkill: () => editor?.chain().deleteRange({ from: 1, to: editor.state.selection.from }).run(),
    onInsert: (piece, typed) => insertAtCaret(editor, piece, typed),
    initialSkill: typed?.skill,
  });
  const slashRef = useRef(slash);
  slashRef.current = slash;
  // The folder is read only once an `@` is typed; the home shows often and most messages have none.
  const folderFiles = useChatFiles(!api && !remote && text.includes("@") ? draft.cwd || null : null, "");
  const mention = useMentionPicker({ files: folderFiles.files, truncated: folderFiles.truncated, chats, cwd: remote ? null : draft.cwd || null, enabled: !busy && !api, onInsert: (piece, typed, chip) => insertAtCaret(editor, piece, typed, chip) });
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const placeholder = slash.skill ? (slash.skill.argumentHint ?? "Add details, or send as is…") : "Describe the task…";
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const submitRef = useRef<() => void>(() => {});
  const pasteRef = useRef(attach.paste);
  pasteRef.current = attach.paste;

  // The same editor as a thread's composer, so a picked `@` shows as a chip here too.
  const editor = useEditor({
    immediatelyRender: false,
    autofocus: "end",
    content: typed?.doc ?? undefined,
    extensions: chatEditorExtensions({ placeholder: () => placeholderRef.current, onEnter: () => submitRef.current() }),
    editorProps: {
      // Before the keymaps, so the picker takes Enter, Tab, arrows and Escape while it is open.
      handleKeyDown: (view, event) => {
        if (event.isComposing || view.composing) return false;
        const { empty, from } = view.state.selection;
        const picker = slashRef.current;
        if (event.key === "Backspace" && empty && from === 1 && picker.backspaceAtStart()) return true;
        if (!(mentionRef.current.keyDown(event.key, event.shiftKey) || picker.keyDown(event.key, event.shiftKey))) return false;
        event.stopPropagation();
        return true;
      },
      attributes: { class: "chat-start-editor", role: "textbox", "aria-label": "Describe the task", "aria-multiline": "true" },
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

  const { drafts: attached } = attach;
  useEffect(() => {
    if (!editor || editor.isDestroyed || busy) return;
    writeComposerDraft(draftKey, { doc: editor.isEmpty ? null : editor.getJSON(), attachments: attached.map((d) => d.attachment), skill: slash.skill });
  }, [editor, draftKey, text, attached, busy, slash.skill]);

  focusAfterDrop.current = () => {
    if (editor && !editor.isDestroyed && !busy) editor.commands.focus("end");
  };

  // A fill (from a pane's "Ask…") goes after what is typed, one blank line apart.
  useEffect(() => {
    if (!fill || !editor || editor.isDestroyed) return;
    if (editor.getText().trim()) editor.chain().focus("end").insertContent([{ type: "paragraph" }, ...paragraphs(fill.text)]).run();
    else editor.chain().setContent({ type: "doc", content: paragraphs(fill.text) }, { emitUpdate: true }).focus("end").run();
    onFilled?.();
  }, [editor, fill, onFilled]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!busy);
  }, [editor, busy]);

  // The placeholder is a decoration; an empty transaction redraws it when the state changes.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder]);

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

  // It grows with the text up to the CSS max-height, then scrolls under the edge fades.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const el = editor.view.dom;
    setOverflow(el.scrollHeight > el.clientHeight + 1);
    markEdges(el);
    const onScroll = () => markEdges(el);
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [editor, text, expanded]);
  submitRef.current = () => void submit();
  const submit = async () => {
    // Read from the editor, not state: a dictated turn sent with ⌘Enter lands in the same tick.
    const current = editor && !editor.isDestroyed ? editor.getText({ blockSeparator: "\n" }) : text;
    if ((!current.trim() && !slash.skill && attach.drafts.length === 0) || blocked || busy) return;
    if (!api && !draft.cwd) return setError("Pick a folder for this chat first.");
    const picked = api && !draft.provider ? { ...draft, model: apiDefault?.value ?? null, provider: apiDefault?.provider ?? null } : draft;
    if (api && !picked.provider) return setError("Add an API provider in Settings › Chat › Accounts first.");
    setBusy(true);
    setError(null);
    try {
      await onStart(picked, slash.message(current.trim()), attach.attachments, stagingId);
      clearComposerDraft(draftKey);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const voice = useChatVoice({
    editor,
    thread: { id: stagingId, name: "the new chat" },
    live: voiceLive,
    send: () => {
      if (busy) return false;
      void submit();
      return true;
    },
  });

  const chooseFolder = () =>
    import("@tauri-apps/plugin-dialog")
      .then(({ open }) => open({ directory: true, defaultPath: draft.cwd || undefined }))
      .then((picked) => typeof picked === "string" && picked && set({ cwd: picked, machine: null }))
      .catch((reason: unknown) => setError(String(reason)));

  return (
    <div className="chat-start-screen">
      <div className="chat-start-body">
        {stats && <p className="chat-start-stats">{stats}</p>}
        <figure className="chat-start-quote">
          <blockquote>“{quote.text}”</blockquote>
          <figcaption>— {quote.by}</figcaption>
        </figure>
        <form
          ref={formRef}
          className="chat-start-input"
          data-dropping={attach.dropping || undefined}
          data-expanded={expanded || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {attach.dropping && <AttachmentDrop />}
          <SlashPopover slash={slash} place="below" />
          <MentionPopover mention={mention} place="below" />
          <AttachmentDrafts drafts={attach.drafts} onRemove={attach.remove} />
          {slash.skill && (
            <div className="chat-start-head">
              <SkillChip slash={slash} />
              <span className="chat-start-skill-desc">{slash.skill.description}</span>
              <AttachButton onPick={attach.pick} disabled={busy} refuse={refuse} />
              {/* The chip's own sr-only button is the accessible one; this is its visible twin. */}
              <button type="button" className="chat-composer-attach" aria-hidden tabIndex={-1} title="Remove skill (⌫ at start)" onClick={slash.removeSkill}>
                <X size={13} />
              </button>
            </div>
          )}
          <div className="chat-start-row">
            {!slash.skill && (
              <span className="chat-start-prompt" aria-hidden>
                ›
              </span>
            )}
            <EditorContent editor={editor} className="chat-start-box" />
            {!slash.skill && <AttachButton onPick={attach.pick} disabled={busy} refuse={refuse} />}
            {!voice.capturing && <ChatMicButton voice={voice} primary={!text.trim()} disabled={busy} />}
          </div>
          <ChatVoiceHeard voice={voice} />
          {voice.capturing ? (
            <div className="chat-start-foot">
              <ChatVoiceBar voice={voice} />
            </div>
          ) : (text || slash.skill || voice.polished) && (
            <div className="chat-start-foot">
              {voice.polished && <ChatVoicePolished voice={voice} />}
              {text && (
                <span className="chat-start-count">
                  {lines} {lines === 1 ? "line" : "lines"} · {text.length.toLocaleString()} chars
                </span>
              )}
              {(overflow || expanded) && (
                <button type="button" className="chat-start-expand" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
                  <ChevronsUpDown size={12} aria-hidden />
                  {expanded ? "Collapse" : "Expand"}
                </button>
              )}
              <kbd className="chat-start-kbd">⏎</kbd>
              <button type="submit" className="chat-composer-send chat-start-send" aria-label="Send" disabled={busy || blocked}>
                <ArrowUp size={14} aria-hidden />
              </button>
            </div>
          )}
        </form>
        <ChatVoiceUnder voice={voice} />
        <div className="chat-start-sentence">
          <span>with</span>
          <ChatModelPicker
            variant="link"
            runner={draft.runner}
            // A runner no Lotus Host runs drops a remote pick, and its path with it.
            onRunner={(runner) => set({ runner, model: null, provider: null, effort: null, ...(remote && !runsRemote(runner) ? { machine: null, cwd: "" } : {}) })}
            models={models.models}
            error={models.error}
            current={draft.model}
            provider={draft.provider}
            effort={draft.effort}
            onPick={async (model, _label, effort, provider) => set({ model, effort: effort ?? null, provider: provider ?? null })}
          />
          {api ? <span>· text only</span> : <>
          <span>· in</span>
          {fixedCwd ? <span className="chat-sentence-fixed" title={fixedCwd}>{folderName(fixedCwd)}</span> : <SentencePick label={draft.cwd ? (remote ? `${folderName(draft.cwd)} on ${remote.host}` : folderName(draft.cwd)) : "pick a folder"} title={draft.cwd || undefined}>
            {(close) => (
              <ChatFolderPlaces
                remote={runsRemote(draft.runner)}
                onPick={(machine, project) => {
                  set({ machine, cwd: project.path });
                  close();
                }}
                local={<>
                  {folders.map((cwd) => (
                    <button key={cwd} type="button" className="chat-perm-option chat-folder-option" title={cwd} aria-pressed={!remote && cwd === draft.cwd} onClick={() => {
                        set({ cwd, machine: null });
                        close();
                      }}>
                      <span className="chat-perm-label">{folderName(cwd)}</span>
                      <Check className="chat-perm-check" size={14} aria-hidden />
                      <span className="chat-perm-hint">{parentPath(cwd)}</span>
                    </button>
                  ))}
                  {remote && (
                    <button type="button" className="chat-perm-option chat-folder-option" title={`${draft.cwd} on ${remote.host}`} aria-pressed onClick={close}>
                      <span className="chat-perm-label">{folderName(draft.cwd)}</span>
                      <Check className="chat-perm-check" size={14} aria-hidden />
                      <span className="chat-perm-hint">{remote.host}</span>
                    </button>
                  )}
                  {(folders.length > 0 || remote) && <hr className="chat-perm-sep" />}
                  <button type="button" className="chat-folder-add" onClick={() => {
                      close();
                      void chooseFolder();
                    }}>
                    <Plus size={13} aria-hidden />
                    {runsRemote(draft.runner) ? "Choose folder on this Mac…" : "Choose folder…"}
                  </button>
                </>}
              />
            )}
          </SentencePick>}
          <span>·</span>
          <SentencePick label={mode.label.toLowerCase()} icon={<PermissionGlyph mode={mode.mode} />}>
            {(close) => (
              <PermissionList
                current={draft.permissionMode}
                onPick={(permissionMode) => {
                  set({ permissionMode });
                  close();
                }}
                foot="Applies to this new chat."
              />
            )}
          </SentencePick>
          </>}
        </div>
        {notice && (
          <p className="chat-start-error" role="alert">
            {notice}
          </p>
        )}
      </div>
      <Dither className="chat-start-field" field={topography} cell={3} gap />
    </div>
  );
}

/** Fades only the edge that has more text past it; written to the form so CSS needs no re-render. */
function markEdges(box: HTMLElement) {
  const form = box.closest("form");
  if (!form) return;
  const { scrollTop: top, scrollHeight: height, clientHeight: shown } = box;
  form.toggleAttribute("data-more-up", top > 1);
  form.toggleAttribute("data-more-down", top + shown < height - 1);
}

function SentencePick({ label, title, icon, children }: { label: string; title?: string; icon?: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div ref={ref} className="chat-model-anchor" data-variant="link">
      <button type="button" className="chat-sentence-link" title={title} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}
        {label}
      </button>
      {open && (
        <div className="chat-model-pop chat-perm-pop" role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
