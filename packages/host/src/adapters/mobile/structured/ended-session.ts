import type { ConversationPage } from "../../../types/conversation.js";
import type { BridgeConversation, ProviderBridgeSession } from "../../../types/provider-bridge.js";
import { runnerTranscriptCaps } from "../conversation/runner-caps.js";

/** Stands in for a saved cell whose runner could not come back, so the cell stays visible with its history. */
export class EndedSession implements ProviderBridgeSession {
  readonly alive = false;
  readonly conversation: BridgeConversation;

  constructor(paneId: string, runner: string, readonly thread: string | undefined) {
    const page: ConversationPage = {
      paneId, runner, capabilities: runnerTranscriptCaps(runner), source: "file", turns: [], hasMore: false,
    };
    this.conversation = { onUpdate: () => undefined, page: () => page, pendingPermission: () => undefined };
  }

  async start(): Promise<void> {}
  async prompt(): Promise<void> {
    throw new Error("this chat ended with a host restart");
  }
  async interrupt(): Promise<void> {}
  decide(): boolean {
    return false;
  }
  close(): void {}
}
