"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowRightToLine, Code2, Columns2, Copy, GitCommitHorizontal, GitGraph, Globe2, Pin, PinOff, Plus, X, XSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { isPathTab, type WorkbenchTab } from "../types";
import { resolveWorkbenchFileIcon } from "@/modules/codespace/services/file-icon-theme";
import { tabFolderHints, type TabCloseScope } from "@/modules/codespace/services/workbench-tab-state";
import { FileTreeContextMenu, type FileTreeMenuItem } from "./FileTreeContextMenu";

interface WorkbenchTabBarProps {
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  /** From the tab's right-click menu. */
  onCloseTabs: (tabId: string, scope: TabCloseScope) => void;
  onNewUrlTab: () => void;
  /** Double-click on a preview tab: it stays when the next file is clicked in the tree. */
  onKeepTab?: (tabId: string) => void;
  onPinTab?: (tabId: string, pinned: boolean) => void;
  /** Drag to reorder; `toIndex` counts in the list without the dragged tab. */
  onMoveTab?: (tabId: string, toIndex: number) => void;
  /** "Split right" in a file tab's menu: the file opens in a new Editor pane beside. */
  onSplitTab?: (tabId: string) => void;
  /** Asked as the menu opens, since whether the pane can split is not React state. */
  canSplit?: () => boolean;
  allowUrlTabs?: boolean;
  allowNewUrlTabs?: boolean;
  /** Pane actions at the end of the strip (Go to file). */
  trailing?: ReactNode;
  /** Open files that were deleted on disk: struck through until saved back or reappearing. */
  deletedPaths?: ReadonlySet<string>;
}

function tabLabel(tab: WorkbenchTab): string {
  if (tab.kind === "url") return tab.title ?? tab.url;
  if (tab.kind === "commit") return tab.subject ? `${tab.subject} · ${tab.sha.slice(0, 7)}` : tab.sha.slice(0, 7);
  if (tab.kind === "graph") return `Git graph · ${tab.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? tab.repoRoot}`;
  const name = tab.filePath.split(/[\\/]/).pop() ?? tab.filePath;
  if (tab.kind === "diff") return `${name} · ${tab.target === "disk" ? "disk" : "diff"}`;
  return name;
}

/** What Copy path copies and the tooltip shows. */
function tabPath(tab: WorkbenchTab): string {
  if (tab.kind === "url") return tab.url;
  if (tab.kind === "commit") return tab.sha;
  if (tab.kind === "graph") return tab.repoRoot;
  return tab.filePath;
}

const TAB_DRAG_TYPE = "application/x-lotus-editor-tab";

/** Which half of a tab a dragged tab is over. */
type DropSide = "before" | "after";

/** A pixel of slack, so a fractional scroll position does not leave a fade on a fully shown edge. */
const EDGE_SLACK = 1;

function menuItemsFor(
  tabs: WorkbenchTab[],
  tab: WorkbenchTab,
  onCloseTabs: (tabId: string, scope: TabCloseScope) => void,
  onPinTab?: (tabId: string, pinned: boolean) => void,
  onSplitTab?: (tabId: string) => void,
): FileTreeMenuItem[] {
  const index = tabs.findIndex((candidate) => candidate.id === tab.id);
  const items: FileTreeMenuItem[] = [{ id: "close", label: "Close", icon: X, run: () => onCloseTabs(tab.id, "one") }];
  if (tabs.length > 1) {
    items.push({ id: "close-others", label: "Close others", icon: XSquare, run: () => onCloseTabs(tab.id, "others") });
  }
  if (index < tabs.length - 1) {
    items.push({ id: "close-right", label: "Close to the right", icon: ArrowRightToLine, run: () => onCloseTabs(tab.id, "right") });
  }
  if (onPinTab) {
    items.push(tab.pinned
      ? { id: "unpin", label: "Unpin", icon: PinOff, groupStart: true, run: () => onPinTab(tab.id, false) }
      : { id: "pin", label: "Pin", icon: Pin, groupStart: true, run: () => onPinTab(tab.id, true) });
  }
  if (onSplitTab && tab.kind === "file") {
    items.push({ id: "split-right", label: "Split right", icon: Columns2, groupStart: !onPinTab, run: () => onSplitTab(tab.id) });
  }
  const path = tabPath(tab);
  if (path) {
    items.push({
      id: "copy-path",
      label: "Copy path",
      icon: Copy,
      groupStart: true,
      run: () => void copyTextToClipboard(path).catch(() => {}),
    });
  }
  return items;
}

export function WorkbenchTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseTabs,
  onNewUrlTab,
  onKeepTab,
  onPinTab,
  onMoveTab,
  onSplitTab,
  canSplit,
  allowUrlTabs = true,
  allowNewUrlTabs = false,
  trailing,
  deletedPaths,
}: WorkbenchTabBarProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const draggedIdRef = useRef<string | null>(null);
  const [dropMark, setDropMark] = useState<{ tabId: string; side: DropSide } | null>(null);
  const folderHints = useMemo(() => tabFolderHints(tabs), [tabs]);

  const dropSide = (event: DragEvent<HTMLElement>): DropSide => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
  };

  const dropOn = (targetId: string, side: DropSide) => {
    const draggedId = draggedIdRef.current;
    draggedIdRef.current = null;
    setDropMark(null);
    if (!draggedId || draggedId === targetId || !onMoveTab) return;
    const others = tabs.filter((tab) => tab.id !== draggedId);
    const targetIndex = others.findIndex((tab) => tab.id === targetId);
    if (targetIndex < 0) return;
    onMoveTab(draggedId, side === "before" ? targetIndex : targetIndex + 1);
  };

  // Fade an edge only while tabs are hidden behind it.
  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const start = strip.scrollLeft > EDGE_SLACK;
    const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - EDGE_SLACK;
    setFade((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
  }, []);

  const revealActive = useCallback(() => {
    if (!activeTabId) return;
    const element = Array.from(stripRef.current?.children ?? []).find(
      (child) => (child as HTMLElement).dataset.tabId === activeTabId,
    );
    // `scroll-margin-inline` on the tab keeps it clear of the fade.
    element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  // A rename can widen a label without changing the count.
  useLayoutEffect(() => {
    measure();
  }, [measure, tabs]);

  // A narrower pane must not push the active tab out of sight.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      measure();
      revealActive();
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measure, revealActive]);

  // A mouse wheel only scrolls vertically; the strip only scrolls sideways. Native and
  // non-passive, so the page behind does not scroll too.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
      measure();
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [measure]);

  // The active tab is always on screen: after opening a file from the tree, ⌘P, or a reopen.
  useEffect(() => {
    revealActive();
  }, [revealActive, tabs.length]);

  const menuTab = menu ? tabs.find((tab) => tab.id === menu.tabId) ?? null : null;

  return (
    <div className="codespace-workbench-tabbar">
      <div
        ref={stripRef}
        className="codespace-workbench-tabstrip"
        role="tablist"
        aria-label="Open editor tabs"
        data-fade-start={fade.start ? "true" : undefined}
        data-fade-end={fade.end ? "true" : undefined}
        onScroll={measure}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const fileIcon = isPathTab(tab) ? resolveWorkbenchFileIcon(tab.filePath) : null;
          const label = tabLabel(tab);
          const deleted = tab.kind === "file" && Boolean(deletedPaths?.has(tab.filePath));
          const preview = tab.kind === "file" && Boolean(tab.preview);
          const folderHint = folderHints.get(tab.id);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              data-preview={preview ? "true" : undefined}
              data-pinned={tab.pinned ? "true" : undefined}
              data-drop={dropMark?.tabId === tab.id ? dropMark.side : undefined}
              draggable={Boolean(onMoveTab)}
              onDragStart={(event) => {
                draggedIdRef.current = tab.id;
                event.dataTransfer.effectAllowed = "move";
                // A drag needs data to start. Not text: dropped on a terminal it would type the path.
                event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
              }}
              onDragOver={(event) => {
                if (!draggedIdRef.current || draggedIdRef.current === tab.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const side = dropSide(event);
                setDropMark((previous) => (previous?.tabId === tab.id && previous.side === side ? previous : { tabId: tab.id, side }));
              }}
              onDragLeave={() => setDropMark((previous) => (previous?.tabId === tab.id ? null : previous))}
              onDrop={(event) => {
                if (!draggedIdRef.current) return;
                event.preventDefault();
                dropOn(tab.id, dropSide(event));
              }}
              onDragEnd={() => {
                draggedIdRef.current = null;
                setDropMark(null);
              }}
              // The wheel button's press would start the page's autoscroll; its click closes.
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                // A pinned tab only closes on purpose, from its menu (VS Code's default).
                if (!tab.pinned) onCloseTab(tab.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
              }}
              className={cn(
                "codespace-workbench-tab group",
                active && "codespace-workbench-tab-active",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={deleted ? `${tabPath(tab)} (deleted on disk)` : tabPath(tab)}
                onClick={() => onSelectTab(tab.id)}
                onDoubleClick={() => {
                  if (preview) onKeepTab?.(tab.id);
                }}
                className="codespace-workbench-tab-main"
              >
                {tab.kind === "url" ? (
                  <Globe2 className="codespace-workbench-tab-icon text-blue-300/64" />
                ) : tab.kind === "commit" ? (
                  <GitCommitHorizontal className="codespace-workbench-tab-icon" aria-hidden="true" />
                ) : tab.kind === "graph" ? (
                  <GitGraph className="codespace-workbench-tab-icon" aria-hidden="true" />
                ) : fileIcon ? (
                  <Image
                    src={fileIcon.src}
                    alt=""
                    aria-hidden="true"
                    width={12}
                    height={12}
                    unoptimized
                    className="codespace-workbench-tab-icon"
                    draggable={false}
                  />
                ) : (
                  <Code2 className="codespace-workbench-tab-icon text-cyan-200/64" />
                )}
                <span className={cn("min-w-0 truncate", deleted && "codespace-workbench-tab-deleted", preview && "codespace-workbench-tab-preview")}>
                  {label}
                  {deleted ? <span className="sr-only"> (deleted on disk)</span> : null}
                </span>
                {folderHint ? <span className="codespace-workbench-tab-folder"><span className="sr-only"> in </span>{folderHint}</span> : null}
                {"dirty" in tab && tab.dirty ? (
                  <span className="codespace-workbench-tab-dirty" aria-label="Unsaved changes" />
                ) : null}
              </button>
              {tab.pinned && onPinTab ? (
                <button
                  type="button"
                  className="codespace-workbench-tab-close codespace-workbench-tab-pin"
                  aria-label={`Unpin ${label}`}
                  title={`Unpin ${label}`}
                  onClick={() => onPinTab(tab.id, false)}
                >
                  <Pin className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="codespace-workbench-tab-close"
                  aria-label={`Close ${label}`}
                  title={`Close ${label}`}
                  onClick={() => onCloseTab(tab.id)}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
        {allowUrlTabs && allowNewUrlTabs && (
          <button
            type="button"
            className="codespace-workbench-tab-new"
            aria-label="New URL tab"
            onClick={onNewUrlTab}
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1 px-1.5">{trailing}</div> : null}
      {menu && menuTab ? (
        <FileTreeContextMenu
          label={`Actions for ${tabLabel(menuTab)}`}
          items={menuItemsFor(tabs, menuTab, onCloseTabs, onPinTab, canSplit?.() ? onSplitTab : undefined)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
