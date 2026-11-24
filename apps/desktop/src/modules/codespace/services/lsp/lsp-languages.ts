/*
 * Which language server a file gets. The server ids match `editor_lsp.rs`, which knows where
 * each one is installed; the editor language ids are `editor-languages.ts`'s (Shiki names).
 */

import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";

export type LspServerId = "typescript" | "rust" | "python" | "go" | "clangd";

/** Editor language → the server for it and the language id LSP expects. */
const BY_EDITOR_LANGUAGE: Record<string, { serverId: LspServerId; languageId: string }> = {
  typescript: { serverId: "typescript", languageId: "typescript" },
  tsx: { serverId: "typescript", languageId: "typescriptreact" },
  javascript: { serverId: "typescript", languageId: "javascript" },
  jsx: { serverId: "typescript", languageId: "javascriptreact" },
  rust: { serverId: "rust", languageId: "rust" },
  python: { serverId: "python", languageId: "python" },
  go: { serverId: "go", languageId: "go" },
  c: { serverId: "clangd", languageId: "c" },
  cpp: { serverId: "clangd", languageId: "cpp" },
};

export type LspFileLanguage = { serverId: LspServerId; languageId: string; editorLanguage: string };

export function lspLanguageForFile(path: string | null | undefined): LspFileLanguage | null {
  if (!path) return null;
  const editorLanguage = resolveEditorLanguage(path);
  const entry = BY_EDITOR_LANGUAGE[editorLanguage];
  return entry ? { ...entry, editorLanguage } : null;
}

/** The editor languages one server serves: its features are registered for these. */
export function editorLanguagesForServer(serverId: LspServerId): string[] {
  return Object.entries(BY_EDITOR_LANGUAGE)
    .filter(([, entry]) => entry.serverId === serverId)
    .map(([language]) => language);
}
