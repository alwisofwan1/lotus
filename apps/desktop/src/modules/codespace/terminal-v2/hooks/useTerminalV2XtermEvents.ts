"use client";

import { useCallback } from "react";
import {
  attachTerminalV2XtermEvents,
  type TerminalV2XtermEventAdapterOptions,
  type TerminalV2XtermEventDisposable,
} from "../rendering/terminal-v2-xterm-event-adapter";

export type TerminalV2XtermEventAdapter = (
  request: TerminalV2XtermEventAdapterOptions,
) => TerminalV2XtermEventDisposable;

export type UseTerminalV2XtermEventsOptions = {
  attachEvents?: TerminalV2XtermEventAdapter;
};

export function useTerminalV2XtermEvents({
  attachEvents = attachTerminalV2XtermEvents,
}: UseTerminalV2XtermEventsOptions = {}): TerminalV2XtermEventAdapter {
  return useCallback((request) => attachEvents(request), [attachEvents]);
}
