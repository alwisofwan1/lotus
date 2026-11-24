export interface CanvasProjectViewState {
  version: 1;
  mode: "board" | "focus";
  heroNodeId: string | null;
}

const STORAGE_PREFIX = "lotus.codecanvas.view.";
const memoryFallback = new Map<string, CanvasProjectViewState>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function key(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function boardState(): CanvasProjectViewState {
  return { version: 1, mode: "board", heroNodeId: null };
}

function parseState(raw: string | null): CanvasProjectViewState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; mode?: unknown; heroNodeId?: unknown };
    if (value.version !== 1) return null;
    if (value.mode === "board") return boardState();
    // "fleet" comes from saves made before Fleet moved into the Canvas Dock: the same hero, focused.
    if ((value.mode !== "focus" && value.mode !== "fleet") || typeof value.heroNodeId !== "string" || !value.heroNodeId) return null;
    return { version: 1, mode: "focus", heroNodeId: value.heroNodeId };
  } catch {
    return null;
  }
}

function write(projectId: string, state: CanvasProjectViewState): void {
  memoryFallback.set(projectId, state);
  try {
    storage()?.setItem(key(projectId), JSON.stringify(state));
  } catch {
    // View persistence is best-effort. The current session still uses the memory fallback.
  }
}

export const canvasProjectViewStateStore = {
  read(projectId: string | null | undefined): CanvasProjectViewState {
    if (!projectId) return boardState();
    const persisted = (() => {
      try {
        return parseState(storage()?.getItem(key(projectId)) ?? null);
      } catch {
        return null;
      }
    })();
    return persisted ?? memoryFallback.get(projectId) ?? boardState();
  },

  rememberFocus(projectId: string, heroNodeId: string): void {
    if (!projectId || !heroNodeId) return;
    write(projectId, { version: 1, mode: "focus", heroNodeId });
  },

  rememberBoard(projectId: string): void {
    if (!projectId) return;
    write(projectId, boardState());
  },

  forget(projectId: string): void {
    if (!projectId) return;
    memoryFallback.delete(projectId);
    try {
      storage()?.removeItem(key(projectId));
    } catch {
      // Best-effort cleanup; a storage failure cannot block closing a project.
    }
  },
};

export function resetCanvasProjectViewStateStoreForTests(): void {
  memoryFallback.clear();
}
