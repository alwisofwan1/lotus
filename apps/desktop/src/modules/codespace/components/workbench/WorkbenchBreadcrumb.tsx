"use client";

import Image from "next/image";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { ChevronRight, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EditorListEntry } from "@/lib/tauri-api";
import { useDismissableLayer } from "@/modules/codespace/hooks/useDismissableLayer";
import { resolveWorkbenchFileIcon, resolveWorkbenchFolderIcon } from "@/modules/codespace/services/file-icon-theme";

interface WorkbenchBreadcrumbProps {
  rootDir: string;
  filePath: string;
  /** The entries of one folder, for the list a crumb opens. */
  listDirectory: (absoluteDirPath: string) => Promise<EditorListEntry[]>;
  onOpenFile: (filePath: string) => void;
  wordWrap: boolean;
  onToggleWordWrap: () => void;
  /** More actions at the right, before word wrap (the Markdown preview toggle). */
  trailing?: ReactNode;
}

type Crumb = { name: string; absolutePath: string; kind: "file" | "directory" };

type OpenList = {
  directory: string;
  name: string;
  entries: EditorListEntry[] | null;
  error: boolean;
};

const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
const baseName = (value: string) => normalize(value).split("/").pop() ?? value;

/** Path from the workspace root. A file outside it keeps its whole path. */
function crumbsFor(rootDir: string, filePath: string): Crumb[] {
  const root = normalize(rootDir);
  const file = normalize(filePath);
  const inside = file.startsWith(`${root}/`);
  const base = inside ? root : "";
  const segments = (inside ? file.slice(root.length + 1) : file).split("/").filter(Boolean);
  // Outside the root, a POSIX path starts at "/"; a Windows one at its drive ("C:").
  let at = base;
  return segments.map((name, index) => {
    at = at ? `${at}/${name}` : `${file.startsWith("/") ? "/" : ""}${name}`;
    return { name, absolutePath: at, kind: index === segments.length - 1 ? "file" : "directory" };
  });
}

function sortEntries(entries: EditorListEntry[]): EditorListEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return baseName(left.path).localeCompare(baseName(right.path), undefined, { sensitivity: "base" });
  });
}

export function WorkbenchBreadcrumb({
  rootDir,
  filePath,
  listDirectory,
  onOpenFile,
  wordWrap,
  onToggleWordWrap,
  trailing,
}: WorkbenchBreadcrumbProps) {
  const crumbs = crumbsFor(rootDir, filePath);
  const [list, setList] = useState<OpenList | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  // The folder asked for last: a slow listing must not replace a newer one.
  const requestedRef = useRef<string | null>(null);

  const close = useCallback(() => {
    requestedRef.current = null;
    setList(null);
  }, []);
  useDismissableLayer({ open: list !== null, ref: layerRef, onDismiss: close });

  const openList = (directory: string) => {
    requestedRef.current = directory;
    setList({ directory, name: baseName(directory), entries: null, error: false });
    listDirectory(directory)
      .then((entries) => {
        if (requestedRef.current === directory) setList({ directory, name: baseName(directory), entries: sortEntries(entries), error: false });
      })
      .catch(() => {
        if (requestedRef.current === directory) setList({ directory, name: baseName(directory), entries: [], error: true });
      });
  };

  const current = normalize(filePath);

  return (
    <div ref={layerRef} className="codespace-workbench-breadcrumb">
      <nav aria-label="File path" className="codespace-workbench-breadcrumb-path">
        {crumbs.map((crumb, index) => {
          const icon = crumb.kind === "file" ? resolveWorkbenchFileIcon(crumb.absolutePath) : null;
          // A folder lists itself; the file lists the folder it is in.
          const directory = crumb.kind === "directory"
            ? crumb.absolutePath
            : index > 0 ? crumbs[index - 1].absolutePath : normalize(rootDir);
          return (
            <span key={crumb.absolutePath} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" /> : null}
              <button
                type="button"
                className={cn(
                  "codespace-workbench-breadcrumb-crumb",
                  crumb.kind === "file" && "codespace-workbench-breadcrumb-crumb--file",
                )}
                aria-haspopup="menu"
                aria-expanded={list?.directory === directory ? true : undefined}
                onClick={() => (list?.directory === directory ? close() : openList(directory))}
              >
                {icon ? <Image src={icon.src} alt="" aria-hidden="true" width={14} height={14} unoptimized /> : null}
                <span className="truncate">{crumb.name}</span>
              </button>
            </span>
          );
        })}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {trailing}
        <button
          type="button"
          className={cn("codespace-workbench-toolbar-button", wordWrap && "codespace-workbench-toolbar-button--preview-on")}
          aria-label="Word wrap"
          aria-pressed={wordWrap}
          title={wordWrap ? "Word wrap is on" : "Word wrap is off"}
          onClick={onToggleWordWrap}
        >
          <WrapText className="h-3.5 w-3.5" />
        </button>
      </div>
      {list ? (
        <div role="menu" aria-label={list.name} className="codespace-workbench-breadcrumb-menu">
          {list.entries === null ? (
            <p className="codespace-workbench-breadcrumb-note">Reading…</p>
          ) : list.error ? (
            <p className="codespace-workbench-breadcrumb-note">Cannot read this folder.</p>
          ) : list.entries.length === 0 ? (
            <p className="codespace-workbench-breadcrumb-note">Empty folder.</p>
          ) : (
            list.entries.map((entry) => {
              const name = baseName(entry.path);
              const icon = entry.kind === "file" ? resolveWorkbenchFileIcon(entry.path) : resolveWorkbenchFolderIcon(entry.path, false);
              const isCurrent = normalize(entry.path) === current;
              return (
                <button
                  key={entry.path}
                  type="button"
                  role="menuitem"
                  aria-current={isCurrent ? "true" : undefined}
                  className={cn("codespace-workbench-breadcrumb-item", isCurrent && "codespace-workbench-breadcrumb-item--current")}
                  onClick={() => {
                    if (entry.kind === "directory") {
                      openList(normalize(entry.path));
                      return;
                    }
                    close();
                    onOpenFile(entry.path);
                  }}
                >
                  <Image src={icon.src} alt="" aria-hidden="true" width={14} height={14} unoptimized />
                  <span className="truncate">{name}</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
