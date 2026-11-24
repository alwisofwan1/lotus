import { parsePtySessionEnd } from "@/lib/pty-session-end";
import { extractTerminalCwdUpdates } from "@/modules/codespace/services/terminal-cwd-probe";
import { parseOsc133, type Osc133Event } from "@/modules/codespace/services/terminal-osc133";

export type TerminalV2PaneRuntimeOutputState = "ready_visible" | "ready_hidden" | string;

export type TerminalV2OutputRoute = "visible" | "hidden" | "none";

export type TerminalV2OutputEventInput = {
  data: string;
  paneRuntimeState: TerminalV2PaneRuntimeOutputState;
  trustPromptSeen: boolean;
  cwd: string;
  cwdTrusted: boolean;
  hasActiveSuggestionRemainder: boolean;
};

export type TerminalV2OutputEventResult = {
  visibleData: string;
  cwdUpdates: string[];
  osc133Events: Osc133Event[];
  exitCode: number | null;
  outputRoute: TerminalV2OutputRoute;
  nextTrustPromptSeen: boolean;
  autoTrustResponse: string | null;
  rememberTrustedCwd: boolean;
  resizeAfterTrust: boolean;
  scheduleSuggestionLayout: boolean;
};

function routeOutput(visibleData: string, paneRuntimeState: TerminalV2PaneRuntimeOutputState): TerminalV2OutputRoute {
  if (!visibleData) return "none";
  return paneRuntimeState === "ready_visible" ? "visible" : "hidden";
}

export function processTerminalV2OutputEvent({
  data,
  paneRuntimeState,
  trustPromptSeen,
  cwdTrusted,
  hasActiveSuggestionRemainder,
}: TerminalV2OutputEventInput): TerminalV2OutputEventResult {
  const exitCode = parsePtySessionEnd(data);
  if (exitCode !== null) {
    return {
      visibleData: "",
      cwdUpdates: [],
      osc133Events: [],
      exitCode,
      outputRoute: "none",
      nextTrustPromptSeen: trustPromptSeen,
      autoTrustResponse: null,
      rememberTrustedCwd: false,
      resizeAfterTrust: false,
      scheduleSuggestionLayout: false,
    };
  }

  const cwdResult = extractTerminalCwdUpdates(data);
  const { visibleData, events: osc133Events } = parseOsc133(cwdResult.visibleData);
  const outputRoute = routeOutput(visibleData, paneRuntimeState);
  const sawTrustPrompt = !trustPromptSeen && /trust.*folder|folder.*trust/i.test(visibleData);
  const rememberTrustedCwd = /i trust this folder|trust this folder/i.test(visibleData);

  return {
    visibleData,
    cwdUpdates: cwdResult.cwdUpdates,
    osc133Events,
    exitCode: null,
    outputRoute,
    nextTrustPromptSeen: trustPromptSeen || sawTrustPrompt,
    autoTrustResponse: sawTrustPrompt && cwdTrusted ? "1\r" : null,
    rememberTrustedCwd,
    resizeAfterTrust: rememberTrustedCwd,
    scheduleSuggestionLayout: outputRoute === "visible" && hasActiveSuggestionRemainder,
  };
}
