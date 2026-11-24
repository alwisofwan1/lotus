"use client";

import { useEffect, useState } from "react";
import {
  getLspFileStatus,
  lspProblemCounts,
  onLspStatusChange,
  type LspFileStatus,
  type LspPlace,
} from "@/modules/codespace/services/lsp/lsp-manager";

type LspStatusView = {
  status: LspFileStatus | null;
  /** Null while no server of this workspace runs: no count is better than a false zero. */
  problems: { errors: number; warnings: number } | null;
};

function read(path: string | null, place: LspPlace): LspStatusView {
  const status = getLspFileStatus(path);
  const counts = lspProblemCounts(place);
  const running = status?.kind === "ready" || counts.errors > 0 || counts.warnings > 0;
  return { status, problems: running ? counts : null };
}

/** The language server state of the shown file and the workspace's problem counts, kept current. */
export function useLspStatus(path: string | null, place: LspPlace): LspStatusView {
  const [view, setView] = useState<LspStatusView>(() => read(path, place));
  useEffect(() => {
    const update = () => {
      setView((current) => {
        const next = read(path, place);
        return JSON.stringify(next) === JSON.stringify(current) ? current : next;
      });
    };
    update();
    return onLspStatusChange(update);
  }, [path, place]);
  return view;
}
