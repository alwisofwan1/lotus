"use client";

import { useCallback, useEffect, useState } from "react";
import { getPaneAgentTitle } from "@/lib/tauri-api";
import { ChatAccountPicker, ChatLimitBar, nextAccount, useClaudeAccountChoices } from "@/modules/chat/ui/ChatAccount";
import { closeTerminalSession } from "@/modules/codespace/services/terminal-session-registry";
import { claudeResumeCommand, claudeSessionIdFromTranscript } from "../services/agent-catalog";

/**
 * A Claude pane's account chip (mockups/account-picker-everywhere.html, decisions 8–9): the account
 * it runs on, and a move to another that restarts the pane in place with `--resume`. The
 * conversation is the one its hooks last reported (`pane_agent_title`); without one it starts fresh,
 * and the confirm says so.
 */
export function PaneAccountChip({
  paneId,
  account,
  command,
  name,
  busy,
  onMove,
}: {
  paneId: string;
  /** The pane's own account; absent = the default for new work. */
  account: string | undefined;
  command: string;
  name: string;
  /** Mid-turn: a restart would cut the reply off. */
  busy: boolean;
  onMove: (account: string, command: string) => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const learn = useCallback(async () => {
    const id = claudeSessionIdFromTranscript((await getPaneAgentTitle(paneId).catch(() => null))?.sessionKey);
    setSessionId(id);
    return id;
  }, [paneId]);
  useEffect(() => {
    void learn();
  }, [learn]);
  const [accounts, refresh] = useClaudeAccountChoices(account ?? null, sessionId !== null);

  return (
    <span className="ws-pane-account" onPointerDown={(e) => e.stopPropagation()}>
      <ChatAccountPicker
        accounts={accounts}
        current={account ?? accounts.find((a) => a.inUse)?.account ?? null}
        disabled={busy}
        below
        subject={name}
        onOpen={() => {
          refresh();
          void learn();
        }}
        footer="Restarts the agent; the conversation continues there."
        confirm={(to) =>
          sessionId
            ? `Restart ${name} on ${to}? The conversation continues there.`
            : `Restart ${name} on ${to}? Lotus does not know its conversation yet, so it starts fresh.`
        }
        onPick={(to) => movePaneToAccount(paneId, command, to, onMove)}
      />
    </span>
  );
}

/** Restart the pane's agent on `to`, resuming the conversation its hooks last reported. */
async function movePaneToAccount(
  paneId: string,
  command: string,
  to: string,
  onMove: (account: string, command: string) => void,
) {
  // Read now: the pane may have moved to another conversation since the chip opened.
  const id = claudeSessionIdFromTranscript((await getPaneAgentTitle(paneId).catch(() => null))?.sessionKey);
  closeTerminalSession(paneId);
  onMove(to, claudeResumeCommand(command, id));
}

/**
 * Under a Claude pane whose turn died on a usage limit (mockups/account-picker-everywhere.html,
 * decision 7): the CLI's words and one click to carry on elsewhere, the same restart as the chip.
 */
export function PaneLimitStrip({
  paneId,
  account,
  command,
  limit,
  onMove,
}: {
  paneId: string;
  account: string | undefined;
  command: string;
  limit: string;
  onMove: (account: string, command: string) => void;
}) {
  // The chip's choices: an Isolated account keeps its own transcripts, so --resume would start over.
  const [accounts] = useClaudeAccountChoices(account ?? null, true);
  const current = account ?? accounts.find((a) => a.inUse)?.account ?? null;
  return (
    <div className="ws-pane-limit">
      <ChatLimitBar
        current={current}
        resetsAtMs={null}
        note={limit}
        next={nextAccount(accounts, current)}
        onContinue={(to) => void movePaneToAccount(paneId, command, to, onMove)}
      />
    </div>
  );
}
