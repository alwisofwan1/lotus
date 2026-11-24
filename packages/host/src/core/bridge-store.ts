import { readFileSync } from "node:fs";

import { atomicWriteSync } from "./atomic-write.js";
import { SESSION_ATTACHMENT_TTL_MS } from "./constants.js";
import type { BridgeProvider } from "../types/index.js";

export interface BridgeChatState {
  /** Provider in use for this chat. */
  provider: BridgeProvider;
  /** Last session id returned by the provider (for `--resume`). */
  sessionId: string | null;
  /** Codex model slug chosen from the account's supported models (P1 picker). */
  codexModel?: string;
  /** Claude model alias chosen from the curated picker (opus/sonnet/haiku). */
  claudeModel?: string;
}

interface ChatEntry extends BridgeChatState {
  /** Last activity timestamp (ms since epoch). */
  lastUsedAt: number;
}

interface StoreData {
  chats: Record<string, ChatEntry>;
}

/**
 * Persists per-Telegram-chat → bridge state (provider + Claude session id).
 *
 * - For `claude`: `sessionId` is the Claude conversation id used as `--resume`.
 * - For `codex`: `sessionId` is a placeholder (Codex is single-turn) but kept
 *   for symmetry so the same store handles both providers.
 *
 * Separate from `SessionStore` (PTY UUIDs), because a bridge chat is a
 * provider-CLI conversation, not a Tauri PTY.
 */
export class BridgeStore {
  private data: StoreData = { chats: {} };

  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number = SESSION_ATTACHMENT_TTL_MS,
  ) {
    this.load();
  }

  /** Records the most recent state for `deviceId` and persists. */
  set(deviceId: string, state: BridgeChatState): void {
    this.data.chats[deviceId] = {
      ...state,
      lastUsedAt: Date.now(),
    };
    this.save();
  }

  /** Returns the active state for `deviceId`, or null if none / expired. */
  get(deviceId: string): BridgeChatState | null {
    const entry = this.data.chats[deviceId];
    if (!entry) return null;
    if (Date.now() - entry.lastUsedAt > this.ttlMs) {
      this.clear(deviceId);
      return null;
    }
    return {
      provider: entry.provider,
      sessionId: entry.sessionId,
      ...(entry.codexModel !== undefined ? { codexModel: entry.codexModel } : {}),
      ...(entry.claudeModel !== undefined ? { claudeModel: entry.claudeModel } : {}),
    };
  }

  /** Merges partial changes over the existing state (model prefs are preserved). */
  private merge(deviceId: string, changes: Partial<BridgeChatState>): void {
    const existing = this.get(deviceId) ?? { provider: "claude" as BridgeProvider, sessionId: null };
    this.set(deviceId, { ...existing, ...changes });
  }

  /** Updates only the active provider while keeping any existing session id. */
  setProvider(deviceId: string, provider: BridgeProvider): void {
    const existing = this.get(deviceId);
    this.merge(deviceId, {
      provider,
      // Switching provider invalidates the previous session id.
      sessionId: existing && existing.provider === provider ? existing.sessionId : null,
    });
  }

  /** Records the chosen Codex model slug, keeping provider + session + claude model. */
  setCodexModel(deviceId: string, codexModel: string): void {
    this.merge(deviceId, { codexModel });
  }

  /** Records the chosen Claude model alias, keeping provider + session + codex model. */
  setClaudeModel(deviceId: string, claudeModel: string): void {
    this.merge(deviceId, { claudeModel });
  }

  /** Drops the bridge state for `deviceId` (used by `/detach` / errors). */
  clear(deviceId: string): void {
    delete this.data.chats[deviceId];
    this.save();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private pruneStale(): void {
    const now = Date.now();
    for (const [key, entry] of Object.entries(this.data.chats)) {
      if (now - entry.lastUsedAt > this.ttlMs) {
        delete this.data.chats[key];
      }
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      this.data = JSON.parse(raw) as StoreData;
      this.pruneStale();
    } catch {
      this.data = { chats: {} };
    }
  }

  private save(): void {
    atomicWriteSync(this.filePath, this.data);
  }
}
