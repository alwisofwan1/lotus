"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FolderCog, FolderOpen } from "lucide-react";
import { isTauri } from "@/lib/tauri/runtime";
import { createTauriVaultClient } from "@/modules/tasks/services/vault-api";
import {
  canConnectVault,
  describeVaultProbe,
  type VaultProbe,
} from "@/modules/tasks/services/vault-settings";

/**
 * Connecting a vault, in the row where the vault will live.
 *
 * It opens IN PLACE rather than as a dialog, which is the same call the tracker's one-line composer
 * once made: a dialog is a context switch and two extra clicks for one line of text,
 * and it covers the list you were reading while you decide. Here it is stronger still — the
 * affordance and its result occupy the same row, so nothing moves when you are done.
 *
 * Escape closes. The path is checked as it is typed, and the button stays out of reach until the
 * folder has actually been read, so "Connect" never means "try and see".
 */

/** Long enough that typing a path does not read the disk on every keystroke. */
const PROBE_DEBOUNCE_MS = 400;

export interface VaultConnectRowProps {
  /** The connected vault's path, or empty when there is none. */
  path: string;
  /**
   * `ticketCount` rides along because the form has just read it. Letting the row ask again would
   * be a second trip to the same folder to learn a number already on screen.
   */
  onConnect: (path: string, ticketCount: number) => void;
  onDisconnect: () => void;
  /**
   * Open the form from outside — picking Obsidian in "Add a ticket source" opens it here, in the
   * row where the vault will live. Changes to this value open it; closing is the form's own.
   */
  openRequest?: number;
}

export function VaultConnectRow({ path, onConnect, onDisconnect, openRequest }: VaultConnectRowProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(path);
  const [probe, setProbe] = useState<VaultProbe>({ kind: "unset" });
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const clientRef = useRef(createTauriVaultClient());

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!openRequest) return;
    setDraft(path);
    setOpen(true);
    // Only a NEW request opens it; the path changing underneath must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  // Reading the disk is a trip, so it waits for the typing to settle.
  useEffect(() => {
    if (!open) return;
    const candidate = draft.trim();
    if (!candidate) {
      setProbe({ kind: "unset" });
      return;
    }
    if (!isTauri()) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void clientRef.current
        .list(candidate)
        .then((tickets) => {
          if (!cancelled) setProbe({ kind: "read", ticketCount: tickets.length });
        })
        .catch((cause) => {
          // The reader's sentence already names the path and what was wrong with it.
          if (!cancelled) setProbe({ kind: "failed", reason: String(cause) });
        });
    }, PROBE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, open]);

  const close = useCallback(() => {
    setOpen(false);
    setDraft(path);
    setProbe({ kind: "unset" });
  }, [path]);

  const browse = useCallback(async () => {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: draft.trim() || undefined,
    });
    if (typeof picked === "string" && picked.trim()) setDraft(picked.trim());
  }, [draft]);

  const commit = useCallback(() => {
    if (probe.kind !== "read") return;
    onConnect(draft.trim(), probe.ticketCount);
    setOpen(false);
  }, [draft, onConnect, probe]);

  if (!open) {
    /*
      Once connected, the vault IS one of the ticket sources listed above — with its mark, its name and
      its count. Drawing a second row like a project here would make the nav name it twice. What
      stays is the way back in, and it is deliberately not project-shaped: no glyph, no count,
      quieter than everything around it.
    */
    if (path) {
      return (
        <button
          type="button"
          className="tk-nav-item tk-nav-item--quiet"
          onClick={() => {
            setDraft(path);
            setOpen(true);
          }}
          title={path}
        >
          <FolderCog size={14} strokeWidth={1.75} aria-hidden />
          <span className="tk-nav-label">Change vault</span>
        </button>
      );
    }

    // With no vault there is nothing to change: adding one starts from "Add ticket source".
    return null;
  }

  const found = describeVaultProbe(probe);

  return (
    <div
      className="tk-vault-form"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <label className="tk-vault-label" htmlFor={inputId}>
        Obsidian vault folder
      </label>

      {/* One control, not a field and a button beside it: Browse is an action ON the path, so it
          lives inside the path's own box and the column keeps one edge on each side. */}
      <div className="tk-vault-field">
        <input
          ref={inputRef}
          id={inputId}
          className="tk-vault-input"
          value={draft}
          placeholder="~/workspace/my-vault"
          aria-label="Vault folder"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <button
          type="button"
          className="tk-vault-browse"
          onClick={() => void browse()}
          aria-label="Browse for a folder"
          title="Browse…"
        >
          <FolderOpen size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {/* One line, and it is the whole reason this is not a plain text field: a path that stores
          without checking fails silently until somebody wonders why the list is empty. */}
      <p className="tk-vault-found" data-tone={found.tone}>
        {found.message}
        {probe.kind === "read" ? <span className="tk-vault-scope"> · read-only</span> : null}
      </p>

      {/* Disconnect on the far LEFT, as quiet text: destructive, so it is never where the hand lands.
          Cancel then Connect on the right, the primary last — the order every macOS sheet uses. */}
      <div className="tk-vault-actions">
        {path ? (
          <button
            type="button"
            className="tk-vault-disconnect"
            onClick={() => {
              onDisconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        ) : null}
        <button type="button" className="tk-vault-cancel" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="tk-vault-connect"
          disabled={!canConnectVault(probe)}
          onClick={commit}
        >
          {path ? "Save" : "Connect"}
        </button>
      </div>
    </div>
  );
}

