"use client";

import Image from "next/image";
import { useEffect, useId, useState } from "react";
import { Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveWorkbenchFileIcon } from "@/modules/codespace/services/file-icon-theme";
import { formatRecentAge, type RecentFile } from "@/modules/codespace/services/recent-files";

export type LauncherAction = {
  id: string;
  label: string;
  /** Its shortcut, shown on the button so the mouse is optional. */
  keys: string;
  icon: LucideIcon;
  run: () => void;
};

interface WorkbenchLauncherProps {
  rootDir: string;
  /** Newest first. The caller drops files that are gone. */
  recent: readonly RecentFile[];
  /** Clock for the ages; tests pin it. */
  now?: number;
  /** Only actions that work: a button that does nothing is worse than none. */
  actions: readonly LauncherAction[];
  /** Open the ⌘P palette, with what was typed here so far. */
  onGoToFile: (query: string) => void;
  onOpen: (path: string) => void;
}

const RECENT_LIMIT = 8;

function splitFolder(rootDir: string, path: string): { name: string; folder: string } {
  const root = rootDir.replace(/\/+$/, "");
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? { name: relative, folder: "" } : { name: relative.slice(slash + 1), folder: relative.slice(0, slash) };
}

/** EDITOR 02: an Editor pane with nothing open is a launcher, not a dead card. */
export function WorkbenchLauncher({ rootDir, recent, now, actions, onGoToFile, onOpen }: WorkbenchLauncherProps) {
  const listId = useId();
  // -1: nothing highlighted, so Enter opens the palette.
  const [active, setActive] = useState(-1);
  const shown = recent.slice(0, RECENT_LIMIT);
  // The ages move on while the pane sits empty; a minute is their smallest step.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const timer = window.setInterval(() => setTick(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const clock = now ?? tick;
  const optionId = (index: number) => `${listId}-recent-${index}`;

  return (
    <div className="codespace-launcher">
      <div className="codespace-launcher-column">
        <div className="codespace-launcher-field">
          <Search className="h-[15px] w-[15px] shrink-0 text-[color:var(--codespace-panel-text-quiet)]" aria-hidden="true" />
          <input
            role="combobox"
            aria-label="Go to file"
            aria-expanded={shown.length > 0}
            aria-controls={shown.length > 0 ? listId : undefined}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            placeholder="Go to file…"
            spellCheck={false}
            value=""
            onChange={(event) => {
              if (event.target.value) onGoToFile(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && shown.length > 0) {
                event.preventDefault();
                setActive((index) => (index + 1) % shown.length);
              } else if (event.key === "ArrowUp" && shown.length > 0) {
                event.preventDefault();
                setActive((index) => (index <= 0 ? shown.length - 1 : index - 1));
              } else if (event.key === "Escape") {
                setActive(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (active >= 0 && shown[active]) onOpen(shown[active].path);
                else onGoToFile("");
              }
            }}
            className="codespace-launcher-input"
          />
          <kbd className="codespace-launcher-kbd">⌘P</kbd>
        </div>

        {shown.length > 0 ? (
          <div>
            <p aria-hidden="true" className="codespace-launcher-heading">Recent</p>
            <div id={listId} role="listbox" aria-label="Recent files" className="flex flex-col gap-0.5">
              {shown.map((entry, index) => {
                const { name, folder } = splitFolder(rootDir, entry.path);
                const selected = index === active;
                // "19 min" six times says nothing new: an age is said once per run.
                const age = formatRecentAge(entry.at, clock);
                const sameAsAbove = index > 0 && formatRecentAge(shown[index - 1].at, clock) === age;
                const icon = resolveWorkbenchFileIcon(entry.path);
                return (
                  <div
                    key={entry.path}
                    id={optionId(index)}
                    role="option"
                    aria-label={name}
                    aria-selected={selected}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(-1)}
                    onClick={() => onOpen(entry.path)}
                    className={cn("codespace-launcher-row", selected && "is-active")}
                  >
                    <Image src={icon.src} alt="" aria-hidden="true" width={14} height={14} unoptimized draggable={false} />
                    <span className="codespace-launcher-name">{name}</span>
                    <span className="codespace-launcher-folder" dir="rtl">
                      <bdi>{folder}</bdi>
                    </span>
                    <span className="flex-1" />
                    <span className="codespace-launcher-age">
                      {selected ? "↵ open" : sameAsAbove ? "" : age}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="codespace-launcher-heading">No recent files yet. Pick one in the tree, or type to search.</p>
        )}

        {actions.length > 0 ? (
          <div className="codespace-launcher-actions">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <button key={action.id} type="button" className="codespace-launcher-action" onClick={action.run}>
                  <Icon className="h-[13px] w-[13px] shrink-0" aria-hidden="true" />
                  <span>{action.label}</span>
                  <kbd className="codespace-launcher-keys">{action.keys}</kbd>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
