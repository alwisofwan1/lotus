"use client";

import { useCallback } from "react";
import {
  createTerminalV2OwnedXtermRenderer,
  type CreateTerminalV2OwnedXtermRendererOptions,
  type TerminalV2OwnedXtermRenderer,
} from "../rendering/terminal-v2-owned-xterm-renderer";

export type TerminalV2XtermRendererFactory = (
  request: CreateTerminalV2OwnedXtermRendererOptions,
) => Promise<TerminalV2OwnedXtermRenderer>;

export type UseTerminalV2XtermRendererOptions = {
  createRenderer?: TerminalV2XtermRendererFactory;
};

export function useTerminalV2XtermRenderer({
  createRenderer = createTerminalV2OwnedXtermRenderer,
}: UseTerminalV2XtermRendererOptions = {}): TerminalV2XtermRendererFactory {
  return useCallback((request) => createRenderer(request), [createRenderer]);
}
