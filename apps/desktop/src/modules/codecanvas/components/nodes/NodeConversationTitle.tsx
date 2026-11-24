"use client";

import { generatePaneTitle } from "@/lib/tauri-api";
import { ConversationTitle } from "@/modules/conversation-title/ConversationTitle";
import { refineSessionTitle } from "../../services/session-activity";
import { renameNodeSession } from "../../services/session-mutations";
import type { CanvasSessionRecord } from "../../services/session-record";
import type { CanvasSessionStore } from "../../services/session-store";

interface NodeConversationTitleProps {
  session: CanvasSessionRecord;
  store: CanvasSessionStore;
  /** The node's PTY pane id: Rust reads the conversation's transcript from it. */
  paneId: string;
  provider: "claude" | "codex";
  /** Re-read the node's sessions after a write. */
  onChanged: () => void;
}

/**
 * The Canvas adapter for the shared `ConversationTitle`: a node's title is its active session's.
 * A rename is kept as `manual` (the ask that follows never overwrites it); "" and Regenerate hand
 * it back to the model, which names it from the same transcript a Code pane is named from.
 */
export function NodeConversationTitle({ session, store, paneId, provider, onChanged }: NodeConversationTitleProps) {
  const regenerate = async () => {
    const next = await refineSessionTitle(store, session, async () => (await generatePaneTitle({ paneId, provider })).title);
    if (!next) throw new Error("no usable title");
    onChanged();
  };
  return (
    <ConversationTitle
      title={session.title}
      source={session.titleSource ?? "auto"}
      onRename={(title) => {
        const write = title
          ? renameNodeSession(store, session, title)
          : // Back to automatic: unpinned now, named by the model when it answers.
            store.upsert({ ...session, titleSource: "auto" }).then(regenerate);
        void write.then(onChanged, (error: unknown) => console.warn("[conversation-title] node title failed:", error));
      }}
      onRegenerate={regenerate}
    />
  );
}
