"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Toast } from "@/components/ui/toast";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { AgentList } from "@/modules/shell/components/AgentList";
import {
  agentsLabel,
  answerQuit,
  QUIT_AGENTS_EVENT,
  QUIT_AGENTS_WILL_STOP_EVENT,
  SESSIOND_FALLBACK_EVENT,
  takeKeptAgents,
  takeSessiondFallback,
  type QuitChoice,
  type RunningAgent,
} from "@/modules/shell/services/quit-agents";

const TOAST_MS = 8_000;

type Note = { title: string; detail: string; tone?: "ok" | "warn" };

const FALLBACK_NOTE: Note = {
  title: "Agents will stop when Lotus quits",
  detail: "Session service unavailable",
  tone: "warn",
};

/**
 * The quit questions for running agents (mockups/quit-with-agents.html,
 * mockups/sessiond-fallback-hint.html) and the start-up notes: kept agents are back, or the
 * session service is down so agents run inside Lotus. Mounted once per window.
 */
export function QuitAgentsGuard() {
  const [agents, setAgents] = useState<RunningAgent[] | null>(null);
  const [stranded, setStranded] = useState<RunningAgent[] | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const disposers: Array<() => void> = [];
    let cancelled = false;
    const eventApi = import("@tauri-apps/api/event");
    const on = <T,>(name: string, cb: (payload: T) => void) =>
      void eventApi
        .then((api) => api.listen<T>(name, (event) => cb(event.payload)))
        .then((dispose) => {
          if (cancelled) dispose();
          else disposers.push(dispose);
        })
        .catch((error) => console.warn(`[quit] failed to listen for ${name}:`, error));
    // Taken, not read: the first window to ask gets it, the rest get nothing.
    const takeFallback = () =>
      void takeSessiondFallback()
        .then((fellBack) => {
          if (fellBack && !cancelled) setNote(FALLBACK_NOTE);
        })
        .catch(() => {});

    on<RunningAgent[]>(QUIT_AGENTS_EVENT, setAgents);
    on<RunningAgent[]>(QUIT_AGENTS_WILL_STOP_EVENT, setStranded);
    // The connect may still be running at mount; the event says when it gave up.
    on<null>(SESSIOND_FALLBACK_EVENT, takeFallback);
    takeFallback();
    void takeKeptAgents()
      .then((count) => {
        if (count > 0 && !cancelled) setNote({ title: agentsLabel(count), detail: "Back in their panes" });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      disposers.forEach((dispose) => safeTauriUnlisten(dispose));
    };
  }, []);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [note]);

  const send = (choice: QuitChoice | null, remember: boolean) =>
    void answerQuit(choice, remember).catch((error) => console.warn("[quit] answer failed:", error));

  return (
    <>
      {agents ? (
        <QuitAgentsDialog
          agents={agents}
          onAnswer={(choice, remember) => {
            setAgents(null);
            send(choice, remember);
          }}
        />
      ) : null}
      {stranded ? (
        <QuitWillStopDialog
          agents={stranded}
          onAnswer={(quit) => {
            setStranded(null);
            send(quit ? "stop" : null, false);
          }}
        />
      ) : null}
      {note ? <Toast title={note.title} detail={note.detail} tone={note.tone} /> : null}
    </>
  );
}

export function QuitAgentsDialog({
  agents,
  onAnswer,
}: {
  agents: RunningAgent[];
  onAnswer: (choice: QuitChoice | null, remember: boolean) => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  const [remember, setRemember] = useState(false);
  const one = agents.length === 1;

  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  return (
    // Cancel has no button: Esc or a click outside, like any macOS sheet.
    <Dialog
      role="alertdialog"
      title={agentsLabel(agents.length)}
      description={
        one
          ? "Keep it running after Lotus quits? It returns to its pane next time."
          : "Keep them running after Lotus quits? They return to their panes next time."
      }
      onClose={() => onAnswer(null, false)}
    >
      <AgentList agents={agents} />
      <div className="mt-3 flex items-center gap-2.5 border-t border-(--ui-line) pt-3">
        <span className="mr-auto flex items-center gap-2 text-(--ui-ink-3)" title="Change it later in Settings › CodeSpace">
          <Switch label="Remember my choice" checked={remember} onChange={setRemember} />
          <button type="button" className="hover:text-(--ui-ink)" onClick={() => setRemember((v) => !v)}>Remember</button>
        </span>
        <Button variant="ghost" onClick={() => onAnswer("stop", remember)}>Stop all</Button>
        <Button ref={keepRef} variant="primary" onClick={() => onAnswer("keep", remember)}>Keep running</Button>
      </div>
    </Dialog>
  );
}

/** ⌘Q while agents run inside Lotus because the session service is down: they cannot stay. */
export function QuitWillStopDialog({
  agents,
  onAnswer,
}: {
  agents: RunningAgent[];
  onAnswer: (quit: boolean) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Cancel is the default: quitting here ends work, so Enter must not do it.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <Dialog
      role="alertdialog"
      title={agents.length === 1 ? "1 agent will stop" : `${agents.length} agents will stop`}
      description={
        agents.length === 1
          ? "The session service isn't running, so it can't keep running after Lotus quits."
          : "The session service isn't running, so they can't keep running after Lotus quits."
      }
      onClose={() => onAnswer(false)}
    >
      <AgentList agents={agents} />
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-(--ui-line) pt-3">
        <Button ref={cancelRef} variant="ghost" onClick={() => onAnswer(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => onAnswer(true)}>Quit anyway</Button>
      </div>
    </Dialog>
  );
}
