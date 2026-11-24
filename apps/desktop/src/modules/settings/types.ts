import type { ClaudeEditorSettings } from "@/lib/editor-settings";
import type { PlannerProviderId } from "@/modules/codespace/components/types";

export interface BridgePersonaSettingsRaw {
  mode?: "default" | "preset" | "custom";
  presetId?: string;
  customPrompt?: string;
  lastEditedAt?: number;
}

export interface BridgeOrchestrationSettingsRaw {
  forceFleetSnapshotOnSpawn?: boolean;
  waitIdleAfterSpawn?: boolean;
  waitIdleTimeoutMs?: number;
  fleetPushDebounceMs?: number;
  includeExitedInFleet?: boolean;
}

export interface BridgeNotificationSettingsRaw {
  enabled?: boolean;
  soundEnabled?: boolean;
  notifyFocusedPane?: boolean;
  soundCooldownMs?: number;
  perPaneDedupe?: boolean;
  notifyBridgeDispatches?: boolean;
  notifyProgrammaticPrompts?: boolean;
  minPromptChars?: number;
  minMeaningfulOutputChars?: number;
}

export interface BridgeProviderSettingsRaw {
  plannerProviderId?: PlannerProviderId;
  plannerCliPaths?: Partial<Record<PlannerProviderId, string>>;
  plannerExtraArgs?: Partial<Record<PlannerProviderId, string[]>>;
  claudeCliPath?: string;
  claudeExtraArgs?: string[];
}

export interface BridgeContextSettingsRaw {
  injectWorkspaceState?: boolean;
  includeActiveFileExcerpt?: boolean;
  activeFileExcerptMaxBytes?: number;
  includeOpenTabs?: boolean;
  includeFleet?: boolean;
  lastOutputPreviewMaxChars?: number;
}

export interface BridgeLoggingSettingsRaw {
  captureRawStream?: boolean;
  redactEnvValues?: boolean;
}

export interface BridgeSettingsRaw {
  persona?: BridgePersonaSettingsRaw;
  orchestration?: BridgeOrchestrationSettingsRaw;
  notifications?: BridgeNotificationSettingsRaw;
  providers?: BridgeProviderSettingsRaw;
  context?: BridgeContextSettingsRaw;
  logging?: BridgeLoggingSettingsRaw;
}

/**
 * CodeSpace workspace UX preferences. Owns toggles for the multi-pane
 * terminal grid — separate from Bridge orchestration so they can be
 * tuned independently.
 */
export interface CodeSpaceSettingsRaw {
  /**
   * When ON (default), agent panes auto-generate a conversation title
   * once turn 1 settles (≥4s idle, ≥200 bytes of output, ≥4s since
   * spawn). Turn this OFF to suppress all background `claude --print`
   * sidecar invocations triggered by the title generator. Manual title
   * generation via the header pill remains available either way.
   */
  autoPaneTitles?: boolean;
  /** Shiki theme name used by the workbench editor when the app theme is dark. */
  editorDarkTheme?: string;
  /** Shiki theme name used by the workbench editor when the app theme is light. */
  editorLightTheme?: string;
  /** Code font size in the Editor pane, px (10–24, default 13). */
  editorFontSize?: number;
  /** Wrap long lines in the Editor pane (default off). */
  editorWordWrap?: boolean;
  /** When the Editor pane saves by itself: "off" (default), "afterDelay", "onFocusChange". */
  editorAutoSave?: string;
  editorLanguageServers?: boolean;
  editorTrustedFolders?: string[];
  /** Before a save: format with the language server, trim line ends (not Markdown), end with a line break. */
  editorFormatOnSave?: boolean;
  editorTrimTrailingWhitespace?: boolean;
  editorInsertFinalNewline?: boolean;
  /** The minimap (default off) and sticky scroll (default on). */
  editorMinimap?: boolean;
  editorStickyScroll?: boolean;
  editorInlineBlame?: boolean;
  /** macOS notifications for Needs you, shown only while Lotus is not the front window. */
  needsYouAlerts?: { needsInput?: boolean; done?: boolean };
}

export interface ClaudeSettings {
  env?: Record<string, string>;
  /** Where this machine's Obsidian vault is. Absent, and empty, both mean "no vault". */
  vault?: { path?: string };
  /**
   * Which ticket sources this machine has, in nav order (`ticket-source-settings.ts`). Entries are
   * `{ id, kind }`; the vault's folder stays in `vault.path`. Unknown kinds are kept, not dropped.
   */
  ticketSources?: unknown[];
  teammateMode?: string;
  requirePlanApproval?: boolean;
  dangerouslySkipPermissions?: boolean;
  editorPreference?: ClaudeEditorSettings["editorPreference"];
  editorCommand?: string;
  editorArgs?: string[];
  editorLaunchMode?: ClaudeEditorSettings["editorLaunchMode"];
  "terminal-font-size"?: number;
  bridge?: BridgeSettingsRaw;
  codespace?: CodeSpaceSettingsRaw;
  /** Chat mode. `titleModel`: the Claude model that names a new chat (`chat_runtime/title.rs`).
   *  `conciseReplies`: the reply style agents are told at session start (`chat_runtime/mod.rs`). */
  chat?: { titleModel?: string; conciseReplies?: boolean };
  /** Settings › Worktrees auto rule; off by default (`readWorktreeCleanupSettings`). */
  worktreeCleanup?: { auto?: boolean; days?: number };
  experimental?: ExperimentalSettingsRaw;
}

/**
 * Experimental feature flags. Lives in a dedicated namespace so future
 * pre-GA features can opt in without polluting top-level keys. Each flag
 * is independently nullable — absence means "use the runtime default."
 */
export interface ExperimentalSettingsRaw {
  /** Terminal V2 is the default path; set false to fall back while refactoring. */
  terminalRuntimeV2?: boolean;
  /** Pooled DOM renderer is the default Terminal V2 dev path; set false to fall back to the legacy-host renderer. */
  terminalV2PooledDomRenderer?: boolean;
  [key: string]: unknown;
}
