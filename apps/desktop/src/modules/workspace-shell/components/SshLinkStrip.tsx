import { useEffect, useReducer, useState } from "react";
import {
  retrySessionLink,
  signInSessionLink,
  subscribePtyLink,
  type PtyLinkEvent,
} from "@/lib/tauri/pty-link";
import "@/styles/ssh-link-strip.css";

/** How long "Reconnected" stays up before the strip goes away. */
export const BACK_NOTICE_MS = 3000;

/** OpenSSH's own exit code for "the connection failed or dropped". */
const SSH_LINK_LOST = 255;

/**
 * What the strip over a remote pane shows (plans/ssh-pane-durability, phase 3).
 *
 * - `reconnecting` / `needs-sign-in`: the link to the machine's session daemon is down; the
 *   process still runs there, and the pane holds its input until the link is back.
 * - `back`: the link came back after a drop; shown for `BACK_NOTICE_MS`.
 * - `dropped`: a plain `ssh -t` pane (a machine with no Lotus host) lost its link, and with it
 *   the process.
 */
export type LinkStrip =
  | { kind: "none" }
  | { kind: "reconnecting"; attempt: number; retryAt: number }
  | { kind: "needs-sign-in" }
  | { kind: "back" }
  | { kind: "dropped" };

export type LinkStripAction =
  | { type: "link"; event: PtyLinkEvent; now: number }
  | { type: "exit"; code: number; plainSsh: boolean }
  | { type: "back-done" }
  | { type: "reset" };

export function linkStripReducer(state: LinkStrip, action: LinkStripAction): LinkStrip {
  switch (action.type) {
    case "link": {
      const { event, now } = action;
      if (event.state === "connected") {
        // A "connected" with nothing shown before is not a recovery: say nothing.
        return state.kind === "reconnecting" || state.kind === "needs-sign-in" ? { kind: "back" } : state;
      }
      if (event.state === "needs-sign-in") return { kind: "needs-sign-in" };
      return { kind: "reconnecting", attempt: event.attempt ?? 0, retryAt: now + (event.nextInMs ?? 0) };
    }
    case "exit":
      return action.code === SSH_LINK_LOST && action.plainSsh ? { kind: "dropped" } : state;
    case "back-done":
      return state.kind === "back" ? { kind: "none" } : state;
    case "reset":
      return { kind: "none" };
  }
}

/** The input is held while the far process cannot get it. */
export function holdsInput(state: LinkStrip): boolean {
  return state.kind === "reconnecting" || state.kind === "needs-sign-in";
}

/** The strip state of one pane's PTY session; `onExit` feeds it the session's exit code. */
export function useLinkStrip(sessionId: string | null | undefined, plainSsh: boolean) {
  const [state, dispatch] = useReducer(linkStripReducer, { kind: "none" });

  useEffect(() => {
    // A session that ends clears its id; the "dropped" strip stays until a new session starts.
    if (!sessionId) return;
    dispatch({ type: "reset" });
    return subscribePtyLink(sessionId, (event) => dispatch({ type: "link", event, now: Date.now() }));
  }, [sessionId]);

  useEffect(() => {
    if (state.kind !== "back") return;
    const timer = setTimeout(() => dispatch({ type: "back-done" }), BACK_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state.kind]);

  return {
    state,
    onExit: (code: number) => dispatch({ type: "exit", code, plainSsh }),
  };
}

function secondsLeft(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/** Ticks once a second while a retry countdown is on screen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function SshLinkStrip({ state, sessionId }: { state: LinkStrip; sessionId: string | null | undefined }) {
  const now = useNow(state.kind === "reconnecting");
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [state]);

  if (state.kind === "none") return null;

  const act = (run: (id: string) => Promise<unknown>) => () => {
    if (!sessionId || busy) return;
    setBusy(true);
    run(sessionId).catch((error) => {
      console.warn("[ssh-link-strip]", error);
      setBusy(false);
    });
  };

  if (state.kind === "reconnecting") {
    const left = secondsLeft(state.retryAt, now);
    const when = state.attempt === 0 || left === 0
      ? "menyambung lagi…"
      : `coba ke-${state.attempt + 1} dalam ${left} dtk`;
    return (
      <div className="ws-link-strip" data-tone="warning" role="status">
        <span className="ws-link-strip__spinner" aria-hidden="true" />
        <span className="ws-link-strip__text">
          Koneksi putus. Agent masih jalan di VPS · {when}
        </span>
        <button type="button" className="ws-link-strip__action" onClick={act(retrySessionLink)} disabled={busy}>
          Coba sekarang
        </button>
      </div>
    );
  }

  if (state.kind === "needs-sign-in") {
    return (
      <div className="ws-link-strip" data-tone="warning" role="status">
        <span className="ws-link-strip__text">Sign-in Cloudflare kedaluwarsa. Agent masih jalan di VPS.</span>
        <button
          type="button"
          className="ws-link-strip__action"
          data-primary="true"
          onClick={act(signInSessionLink)}
          disabled={busy}
        >
          {busy ? "Menunggu sign-in…" : "Sign in"}
        </button>
      </div>
    );
  }

  if (state.kind === "back") {
    return (
      <div className="ws-link-strip" data-tone="success" role="status">
        <span className="ws-link-strip__text">Tersambung lagi. Tidak ada output yang hilang.</span>
      </div>
    );
  }

  return (
    <div className="ws-link-strip" data-tone="danger" role="status">
      <span className="ws-link-strip__text">Koneksi putus, proses ikut berhenti. VPS tanpa Lotus host.</span>
    </div>
  );
}
