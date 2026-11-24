"use client";
import "@/styles/chat.css";
import "@/styles/smart-convert.css";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { X, RefreshCw, Plus } from "lucide-react";
import { AGENT_NAMES, ChatModelPicker, useChatModels } from "@/modules/chat/ui/ChatModel";
import { SMART_CONVERT_RUNNERS, parseSmartConvertDraft, runSmartConvert } from "../services/smart-convert-runner";
import type { SmartConvertRunner } from "../services/smart-convert-runner";
import type { SmartConvertDraft, TaskClass, TaskWhen } from "../types/canvas";
import { useCanvasOcclusionLock } from "../hooks/useCanvasOcclusionLock";

// Mockup: mockups/lotus-chat.fig, page "07h Smart Convert".

interface SmartConvertModalProps {
  noteContent: string;
  onConfirm: (draft: SmartConvertDraft) => void;
  onCancel: () => void;
}

const SIZE_OPTIONS: Array<{ value: TaskClass; label: string }> = [
  { value: "quick", label: "Quick" },
  { value: "needs-research", label: "Research" },
  { value: "deep-focus", label: "Deep" },
  { value: "benchmark", label: "Benchmark" },
];

const WHEN_OPTIONS: Array<{ value: TaskWhen; label: string }> = [
  { value: "urgent", label: "Urgent" },
  { value: "this-week", label: "This week" },
  { value: "this-month", label: "This month" },
  { value: "whenever", label: "Whenever" },
];

const SMART_CONVERT_FRONTEND_TIMEOUT_MS = 30_000;

class TimedOut extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut()), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="sc-field">
      <span className="sc-label">{label}</span>
      <div className="sc-seg" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <button key={opt.value} type="button" role="radio" aria-checked={value === opt.value} onClick={() => onChange(opt.value)}>
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SmartConvertModalInner({ noteContent, onConfirm, onCancel }: SmartConvertModalProps) {
  // Rendered only while open (mounted behind a `showModal` gate), so lock for the full lifetime.
  useCanvasOcclusionLock(true, "smart-convert-modal");
  const [runner, setRunner] = useState<SmartConvertRunner>("claude");
  // null = the CLI's default model.
  const [model, setModel] = useState<string | null>(null);
  const { models: listed, error: modelsError } = useChatModels(runner);
  // smart_convert_note fixes Codex's reasoning effort, so the picker offers no effort row.
  const models = useMemo(() => listed.map((m) => ({ ...m, efforts: undefined })), [listed]);
  const [draft, setDraft] = useState<SmartConvertDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const requestSeq = useRef(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const agent = AGENT_NAMES[runner];

  const runConvert = useCallback(async (withRunner: SmartConvertRunner, withModel: string | null) => {
    const content = noteContent.trim();
    if (!content) {
      setDraft(null);
      setError("The note is empty. Write something in it first.");
      return;
    }
    const requestId = ++requestSeq.current;
    setLoading(true);
    // A pick while drafting starts a new request without loading going false: count from it.
    setElapsed(0);
    setError(null);
    try {
      const raw = await withTimeout(runSmartConvert(withRunner, content, withModel ?? ""), SMART_CONVERT_FRONTEND_TIMEOUT_MS);
      if (requestId !== requestSeq.current) return;
      setDraft(parseSmartConvertDraft(raw));
    } catch (e) {
      if (requestId !== requestSeq.current) return;
      setError(
        e instanceof TimedOut
          ? `${AGENT_NAMES[withRunner]} did not answer in ${SMART_CONVERT_FRONTEND_TIMEOUT_MS / 1000} seconds`
          : e instanceof Error ? e.message : String(e),
      );
    } finally {
      if (requestId === requestSeq.current) setLoading(false);
    }
  }, [noteContent]);

  const regenerate = useCallback(() => void runConvert(runner, model), [runConvert, runner, model]);

  // Drafts on open and drops the answer on close. One effect for both: React's dev remount runs the
  // cleanup in between, and a start guarded by a ref left the only request stale, spinning forever.
  useEffect(() => {
    void runConvert("claude", null);
    return () => { requestSeq.current += 1; };
  }, [runConvert]);

  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [loading]);

  // shortcut: the CLI keeps running after Stop (smart_convert_note has no cancel); its answer is dropped.
  const stop = () => {
    requestSeq.current += 1;
    setLoading(false);
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // An open model list closes itself on Escape; the modal stays.
      if (e.key === "Escape" && !modalRef.current?.querySelector(".chat-model-pop")) { e.preventDefault(); onCancel(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (draft && !loading) onConfirm(draft); }
      if ((e.metaKey || e.ctrlKey) && e.key === "r") { e.preventDefault(); regenerate(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, loading, onConfirm, onCancel, regenerate]);

  const pickModel = async (next: string) => {
    setModel(next);
    void runConvert(runner, next);
  };

  const switchRunner = (next: string) => {
    const found = SMART_CONVERT_RUNNERS.find((r) => r === next);
    if (!found) return;
    setRunner(found);
    setModel(null);
    void runConvert(found, null);
  };

  const other: SmartConvertRunner = runner === "claude" ? "codex" : "claude";

  const patchDraft = (patch: Partial<SmartConvertDraft>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const patchCriterion = (id: string, text: string) =>
    setDraft((d) =>
      d ? { ...d, acceptanceCriteria: d.acceptanceCriteria.map((c) => c.id === id ? { ...c, text } : c) } : d
    );

  const toggleCriterion = (id: string) =>
    setDraft((d) =>
      d ? { ...d, acceptanceCriteria: d.acceptanceCriteria.map((c) => c.id === id ? { ...c, done: !c.done } : c) } : d
    );

  const removeCriterion = (id: string) =>
    setDraft((d) =>
      d ? { ...d, acceptanceCriteria: d.acceptanceCriteria.filter((c) => c.id !== id) } : d
    );

  const addCriterion = () =>
    setDraft((d) =>
      d ? { ...d, acceptanceCriteria: [...d.acceptanceCriteria, { id: crypto.randomUUID(), text: "", done: false }] } : d
    );

  const ready = draft !== null && !loading;

  return (
    <div className="sc-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={modalRef} className="sc-modal" role="dialog" aria-modal="true" aria-labelledby="sc-title">
        <header className="sc-head">
          <div className="sc-head-text">
            <h2 id="sc-title">Turn this note into a task</h2>
            <span>Smart Convert</span>
          </div>
          <ChatModelPicker
            models={models}
            error={modelsError}
            current={model}
            runner={runner}
            runners={SMART_CONVERT_RUNNERS}
            onRunner={switchRunner}
            onPick={pickModel}
          />
          <button type="button" className="sc-icon" aria-label="Close" onClick={onCancel}>
            <X size={14} />
          </button>
        </header>

        <div className="sc-source" title={noteContent}>
          <span className="sc-label">From note</span>
          <span className="sc-source-text">{noteContent.trim() || "(empty note)"}</span>
          <span className="sc-source-count">{noteContent.length} chars</span>
        </div>

        <div className="sc-body">
          {loading && (
            <div className="sc-live" role="status">
              <span className="sc-live-dot" aria-hidden />
              <span>{agent} is drafting the task · {elapsed}s</span>
              <button type="button" className="sc-btn" onClick={stop}>Stop</button>
            </div>
          )}

          {loading && !draft && (
            <div className="sc-skeleton" aria-hidden>
              <span /><span /><span /><span /><span />
            </div>
          )}

          {error && !loading && (
            <div className="sc-error" role="alert">
              <strong>{error}</strong>
              <p>Nothing was changed. Your note is as it was. Try again, or pick another model above.</p>
              <div className="sc-error-actions">
                <button type="button" className="sc-btn sc-btn-primary" onClick={regenerate}>Try again</button>
                <button type="button" className="sc-btn" onClick={() => switchRunner(other)}>Use {AGENT_NAMES[other]} instead</button>
              </div>
            </div>
          )}

          {draft && (
            <div className="sc-draft" data-stale={loading || undefined}>
              <label className="sc-field">
                <span className="sc-label">Task</span>
                <input
                  className="sc-title-input"
                  value={draft.title}
                  maxLength={80}
                  onChange={(e) => patchDraft({ title: e.target.value })}
                />
              </label>

              <label className="sc-field">
                <span className="sc-label">Goal</span>
                <textarea
                  className="sc-text"
                  value={draft.intent}
                  rows={3}
                  onChange={(e) => patchDraft({ intent: e.target.value })}
                />
              </label>

              <div className="sc-field">
                <span className="sc-label">Done when</span>
                {draft.acceptanceCriteria.map((c) => (
                  <div key={c.id} className="sc-check">
                    <input type="checkbox" checked={c.done} aria-label="Done" onChange={() => toggleCriterion(c.id)} />
                    <input
                      className="sc-text"
                      value={c.text}
                      placeholder="A check that proves it is done"
                      onChange={(e) => patchCriterion(c.id, e.target.value)}
                    />
                    <button type="button" className="sc-icon" aria-label="Remove check" onClick={() => removeCriterion(c.id)}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button type="button" className="sc-add" onClick={addCriterion}>
                  <Plus size={12} />
                  Add a check
                </button>
              </div>

              <div className="sc-pair">
                <Segmented label="Size" options={SIZE_OPTIONS} value={draft.taskClass} onChange={(taskClass) => patchDraft({ taskClass })} />
                <Segmented label="When" options={WHEN_OPTIONS} value={draft.when} onChange={(when) => patchDraft({ when })} />
              </div>

              {draft.subtasks.length > 0 && (
                <div className="sc-field">
                  <span className="sc-label">Steps</span>
                  <ol className="sc-steps">
                    {draft.subtasks.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="sc-foot">
          <span className="sc-keys">⌘R regenerate · Esc close</span>
          {draft && (
            <button type="button" className="sc-btn" disabled={loading} onClick={regenerate}>
              <RefreshCw size={12} />
              Regenerate
            </button>
          )}
          <button type="button" className="sc-btn sc-btn-primary" disabled={!ready} onClick={() => draft && onConfirm(draft)}>
            Create task
            <kbd>⌘↵</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}

export function SmartConvertModal(props: SmartConvertModalProps) {
  if (typeof document === "undefined") return null;
  return createPortal(<SmartConvertModalInner {...props} />, document.body);
}
