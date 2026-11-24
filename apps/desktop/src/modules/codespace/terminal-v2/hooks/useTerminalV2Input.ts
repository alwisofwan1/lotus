"use client";

import { useMemo } from "react";
import type { TerminalInputMetadata } from "@/modules/codespace/services/terminal-input-events";
import type { TerminalV2Runtime } from "../runtime/terminal-v2-runtime";

export type TerminalV2SessionWriter = {
  write(paneId: string, data: string, metadata?: Partial<TerminalInputMetadata>): void;
};

export type UseTerminalV2InputOptions = {
  runtime: TerminalV2Runtime | null;
};

export type UseTerminalV2InputResult = {
  sessionWriter: TerminalV2SessionWriter | undefined;
};

export function useTerminalV2Input({ runtime }: UseTerminalV2InputOptions): UseTerminalV2InputResult {
  const sessionWriter = useMemo<TerminalV2SessionWriter | undefined>(() => {
    if (!runtime) return undefined;
    return {
      write(paneId, data, metadata) {
        if (!data) return;
        runtime.writePaneInput(paneId, data, metadata);
      },
    };
  }, [runtime]);

  return { sessionWriter };
}
