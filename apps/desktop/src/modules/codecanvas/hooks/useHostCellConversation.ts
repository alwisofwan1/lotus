"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getActiveProjectLocation } from "../services/canvas-active-project";
import { hostConversationFor, hostDispatchFor } from "../services/remote-host";
import {
  BUSY_POLL_MS,
  conversationPollDelayMs,
  readConversationPage,
  type HostConversationPage,
} from "../services/host-conversation";

export interface UseHostCellConversationResult {
  page: HostConversationPage | null;
  /** The last thing that went wrong, kept beside the page rather than replacing it. */
  error: string | null;
  /** True only until the first answer — a poll refreshing in the background is not "loading". */
  loading: boolean;
  /** True while a prompt typed here is on its way to the host. */
  sending: boolean;
  send: (prompt: string) => Promise<void>;
  refresh: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The host could not be reached.";
}

/**
 * Keeps one headless cell's conversation on screen, and sends prompts to it.
 *
 * **Why this polls at all** is argued where the cadence lives (`conversationPollDelayMs`): the
 * host's only push surface wants a phone's pairing credential, and the `/v1` surface reached over
 * the ssh connection the canvas already holds has no stream.
 *
 * **A failed poll never clears the conversation.** A machine mid-reboot, a host restarting, an ssh
 * hiccup — each of those is a reason to show the last good turns with a warning, not to blank a
 * node the operator is reading. The error sits alongside the page, and the next successful poll
 * clears it.
 */
export function useHostCellConversation(paneId: string, visible: boolean): UseHostCellConversationResult {
  const [page, setPage] = useState<HostConversationPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  // Bumped to wake the effect for an out-of-band read: the first paint, and the moment after a
  // dispatch, when waiting out a poll interval would make the canvas look like it swallowed the
  // prompt.
  const [nonce, setNonce] = useState(0);
  // The page the LAST poll read, which is not the same thing as the one in state. `setPage` does
  // not take effect until React re-renders, so scheduling off a ref written during render put the
  // first poll — the one that discovers a live turn — on the idle cadence every time, and the node
  // sat still for seventeen seconds while an agent was mid-reply. Found by the test below.
  const lastReadRef = useRef<HostConversationPage | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const location = getActiveProjectLocation();
      if (!location) {
        // A board with no remote project cannot have adopted anything. Nothing to ask, and no
        // error to report either — this is just a node outliving its project.
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const raw = await hostConversationFor(location, paneId);
        if (cancelled) return;
        const next = readConversationPage(raw);
        if (next) {
          lastReadRef.current = next;
          setPage(next);
          setError(null);
        } else {
          // The call succeeded and what came back was not a conversation. Saying so beats the
          // alternative — "Reading the conversation…" forever, with nothing anywhere to explain
          // why, on a node that is in fact being answered.
          setError("The host answered something this build could not read as a conversation.");
        }
      } catch (caught) {
        if (cancelled) return;
        setError(messageOf(caught));
      } finally {
        if (!cancelled) {
          setLoading(false);
          const delay = conversationPollDelayMs(lastReadRef.current, true);
          if (delay !== null) timer = setTimeout(() => void tick(), delay);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [paneId, visible, nonce]);

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text) return;
      const location = getActiveProjectLocation();
      if (!location) {
        setError("This board is not open on a machine any more.");
        return;
      }
      setSending(true);
      try {
        await hostDispatchFor(location, paneId, text);
        setError(null);
        // The turn the host just opened will not be in the page we are holding. Read again
        // shortly rather than at the idle cadence, which would leave the composer looking inert
        // for the better part of a minute.
        setTimeout(refresh, BUSY_POLL_MS);
        refresh();
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        setSending(false);
      }
    },
    [paneId, refresh],
  );

  return { page, error, loading, sending, send, refresh };
}
