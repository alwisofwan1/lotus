import {
  codecanvasCloseProject,
  codecanvasGetIndex,
  codecanvasLoadProject,
  codecanvasOpenProject,
  codecanvasRenameProject,
  codecanvasSaveProject,
  codecanvasSetActiveProject,
  type CodeCanvasProjectIndex,
  type CodeCanvasProjectLocation,
  type CodeCanvasProjectMeta,
  type CodeCanvasProjectSnapshot,
} from "@/lib/tauri/codecanvas";
import { isTauri } from "@/lib/tauri/runtime";

export interface CodeCanvasProjectRepository {
  getIndex(): Promise<CodeCanvasProjectIndex>;
  openProject(rootDir: string, location?: CodeCanvasProjectLocation | null): Promise<CodeCanvasProjectSnapshot>;
  loadProject(projectId: string): Promise<CodeCanvasProjectSnapshot | null>;
  saveProject(snapshot: CodeCanvasProjectSnapshot): Promise<void>;
  renameProject(projectId: string, alias: string | null): Promise<void>;
  closeProject(projectId: string): Promise<CodeCanvasProjectIndex>;
  setActiveProject(projectId: string | null): Promise<void>;
}

export function createCodeCanvasProjectRepository(): CodeCanvasProjectRepository {
  return isTauri() ? createTauriCodeCanvasProjectRepository() : createInMemoryCodeCanvasProjectRepository();
}

export function createTauriCodeCanvasProjectRepository(): CodeCanvasProjectRepository {
  return {
    getIndex: codecanvasGetIndex,
    openProject: codecanvasOpenProject,
    loadProject: codecanvasLoadProject,
    saveProject: codecanvasSaveProject,
    renameProject: codecanvasRenameProject,
    closeProject: codecanvasCloseProject,
    setActiveProject: codecanvasSetActiveProject,
  };
}

export function createInMemoryCodeCanvasProjectRepository(): CodeCanvasProjectRepository {
  const projects = new Map<string, CodeCanvasProjectMeta>();
  const snapshots = new Map<string, CodeCanvasProjectSnapshot>();
  let activeProjectId: string | null = null;

  const sortedProjects = () => Array.from(projects.values()).sort((a, b) => a.position - b.position);
  const index = (): CodeCanvasProjectIndex => ({ projects: sortedProjects().map(copyMeta), activeProjectId });

  return {
    async getIndex() { return index(); },
    async openProject(rootDir, location) {
      const root = normalizeRootDir(rootDir);
      // Two machines may hold the same path, so identity is the pair — the same rule the SQLite
      // UNIQUE index enforces (`codecanvas_store.rs`).
      const key = location && location.kind === "ssh" ? `${location.user ?? ""}@${location.host}` : "local";
      const machineOf = (p: CodeCanvasProjectMeta) =>
        p.location && p.location.kind === "ssh" ? `${p.location.user ?? ""}@${p.location.host}` : "local";
      const existing = Array.from(projects.values()).find((p) => p.rootDir === root && machineOf(p) === key);
      if (existing) {
        activeProjectId = existing.id;
        return copySnapshot(snapshots.get(existing.id) ?? emptySnapshot(existing));
      }
      const now = Date.now();
      const meta: CodeCanvasProjectMeta = {
        id: `${projectIdForRoot(root)}${key === "local" ? "" : `_${key}`}`, rootDir: root, alias: null,
        position: projects.size, updatedAt: now, lastOpenedAt: now,
        ...(location && location.kind === "ssh" ? { location } : {}),
      };
      const snapshot = emptySnapshot(meta);
      projects.set(meta.id, meta);
      snapshots.set(meta.id, snapshot);
      activeProjectId = meta.id;
      return copySnapshot(snapshot);
    },
    async loadProject(projectId) {
      const snapshot = snapshots.get(projectId);
      return snapshot ? copySnapshot(snapshot) : null;
    },
    async saveProject(snapshot) {
      const now = Date.now();
      const meta = { ...copyMeta(snapshot), updatedAt: now };
      projects.set(snapshot.id, meta);
      snapshots.set(snapshot.id, { ...copySnapshot(snapshot), ...meta });
    },
    async renameProject(projectId, alias) {
      const meta = projects.get(projectId);
      if (!meta) return;
      const next = { ...meta, alias: alias?.trim() || null, updatedAt: Date.now() };
      projects.set(projectId, next);
      const snapshot = snapshots.get(projectId);
      if (snapshot) snapshots.set(projectId, { ...snapshot, ...next });
    },
    async closeProject(projectId) {
      const closed = projects.get(projectId);
      projects.delete(projectId);
      snapshots.delete(projectId);
      if (activeProjectId === projectId) activeProjectId = fallbackActiveId(sortedProjects(), closed?.position ?? -1);
      return index();
    },
    async setActiveProject(projectId) { activeProjectId = projectId; },
  };
}

function emptySnapshot(meta: CodeCanvasProjectMeta): CodeCanvasProjectSnapshot {
  return { ...copyMeta(meta), nodes: [], edges: [], terminalCounter: 0 };
}

function copyMeta(meta: CodeCanvasProjectMeta): CodeCanvasProjectMeta {
  return { ...meta };
}

function copySnapshot(snapshot: CodeCanvasProjectSnapshot): CodeCanvasProjectSnapshot {
  return {
    ...snapshot,
    nodes: structuredClone(snapshot.nodes),
    edges: structuredClone(snapshot.edges),
  };
}

function normalizeRootDir(rootDir: string): string {
  const raw = rootDir.trim();
  if (!raw) throw new Error("Canvas Project root directory is required");
  const normalized = raw.replace(/[\\/]+$/, "");
  return normalized || "/";
}

function fallbackActiveId(projects: CodeCanvasProjectMeta[], closedPosition: number): string | null {
  return projects.find((p) => p.position > closedPosition)?.id
    ?? projects.filter((p) => p.position < closedPosition).at(-1)?.id
    ?? null;
}

/**
 * The id a local Canvas Project at `rootDir` has, or will have once opened — the same FNV hash as
 * `project_id_for` in `codecanvas_store.rs`. Lets a run be recorded under a folder's project
 * without opening it (opening also makes it the active one).
 */
export function localProjectIdForRoot(rootDir: string): string {
  return projectIdForRoot(normalizeRootDir(rootDir));
}

function projectIdForRoot(rootDir: string): string {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (const byte of new TextEncoder().encode(rootDir)) hash = (hash ^ BigInt(byte)) * prime & mask;
  return `cp_${hash.toString(16).padStart(16, "0")}`;
}
