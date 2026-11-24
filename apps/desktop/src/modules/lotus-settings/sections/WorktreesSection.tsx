"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { NumberStepper } from "@/components/ui/number-stepper";
import { Status, type StatusTone } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { copyTextToClipboard } from "@/lib/clipboard";
import { isTauri } from "@/lib/tauri/runtime";
import {
  isSafeToRemove,
  listWorktrees,
  readWorktreeCleanupSettings,
  removeWorktrees,
  restoreCommand,
  WORKTREE_CLEANUP_DAYS,
  worktreeCleanupLog,
  type WorktreeKind,
  type WorktreeLogEntry,
  type WorktreeRow,
} from "@/lib/tauri/worktree-cleanup";
import { SettingRow, SettingsGroup } from "../components/SettingsGroup";
import { SettingsFileSection } from "../components/SettingsFileSection";
import { SettingsSection } from "../components/SettingsSection";

/**
 * Settings › Worktrees (plans/workspace-cleanup/PLAN.md, mockups/settings-worktrees.html): every
 * worktree of every repo Lotus knows, grouped Yours / Chat / Factory, biggest first. The main
 * checkout is never listed. Removal is re-checked in Rust; this view is only what was true at load.
 */

const GROUPS: ReadonlyArray<{ kind: WorktreeKind; title: string }> = [
  { kind: "yours", title: "Your worktrees" },
  { kind: "chat", title: "Chat" },
  { kind: "factory", title: "Factory" },
];

const KB = 1024;
export function formatSize(bytes: number): string {
  if (bytes < KB * KB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  if (bytes < KB ** 3) return `${Math.round(bytes / KB ** 2)} MB`;
  return `${(bytes / KB ** 3).toFixed(1).replace(/\.0$/, "")} GB`;
}

/** "now", "3 h", "21 d"; "" when unknown. */
export function formatAge(lastActiveMs: number, now: number): string {
  if (!lastActiveMs) return "";
  const hours = Math.floor((now - lastActiveMs) / 3_600_000);
  if (hours < 1) return "now";
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

export function summarize(rows: readonly WorktreeRow[]) {
  const safe = rows.filter(isSafeToRemove);
  const total = (list: readonly WorktreeRow[]) => list.reduce((sum, r) => sum + r.sizeBytes, 0);
  return { count: rows.length, bytes: total(rows), safe, safeBytes: total(safe) };
}

function pill(row: WorktreeRow): { tone: StatusTone; text: string } {
  if (row.blocked === "In use") return { tone: "neutral", text: "In use" };
  if (row.state === "hasWork") return { tone: "warn", text: "Has work" };
  return row.state === "merged" ? { tone: "ok", text: "Merged" } : { tone: "neutral", text: "Clean" };
}

const lastSegment = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

export function WorktreesSection() {
  const [rows, setRows] = useState<WorktreeRow[] | null>(null);
  const [log, setLog] = useState<WorktreeLogEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    if (!isTauri()) return;
    setLoadError(null);
    setNow(Date.now());
    listWorktrees().then(setRows, (e: unknown) => setLoadError(String(e)));
    worktreeCleanupLog().then(setLog, () => undefined);
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  const remove = async (paths: string[], discard: boolean) => {
    setBusy(true);
    try {
      const results = await removeWorktrees(paths, discard);
      const failed = Object.fromEntries(results.filter((r) => r.error).map((r) => [r.path, r.error as string]));
      setErrors((old) => ({ ...Object.fromEntries(Object.entries(old).filter(([p]) => !paths.includes(p))), ...failed }));
    } catch (e) {
      setErrors((old) => ({ ...old, ...Object.fromEntries(paths.map((p) => [p, String(e)])) }));
    } finally {
      setBusy(false);
      setPreview(false);
      load();
    }
  };

  const onRowRemove = (row: WorktreeRow) => {
    if (row.state === "hasWork" && armed !== row.path) return setArmed(row.path);
    setArmed(null);
    void remove([row.path], row.state === "hasWork");
  };

  if (!isTauri()) return <p className="ds-t-meta text-(--ui-ink-3)">Worktrees can be managed in the Lotus app.</p>;

  const summary = summarize(rows ?? []);
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup
        description="Every worktree from every repo Lotus knows. Removing one deletes its folder and its local branch, never the remote branch."
        footer={loadError ? <span className="text-(--ui-err)" role="alert">{loadError}</span> : undefined}
      >
        <SettingRow
          label={rows ? `${summary.count} worktrees · ${formatSize(summary.bytes)}` : "Measuring…"}
          description={
            summary.safe.length
              ? `${summary.safe.length} safe to remove · ${formatSize(summary.safeBytes)}`
              : "Nothing safe to remove. Only Merged or Clean worktrees not in use can be removed."
          }
        >
          <Button variant="ghost" size="sm" icon aria-label="Refresh" title="Refresh" disabled={busy} onClick={load}>
            <RefreshCw size={13} />
          </Button>
          {summary.safe.length ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => setPreview(true)}>
              {`Clean up ${summary.safe.length}…`}
            </Button>
          ) : null}
        </SettingRow>
      </SettingsGroup>

      <AutoRule />

      {rows && rows.length === 0 ? (
        <SettingsGroup title="No worktrees">
          <SettingRow label="Only the main checkouts" description="Nothing to clean up." muted />
        </SettingsGroup>
      ) : null}

      {GROUPS.map(({ kind, title }) => {
        const list = (rows ?? []).filter((r) => r.kind === kind);
        if (list.length === 0) return null;
        return (
          <SettingsGroup key={kind} title={title} meta={`${list.length}`} as="ul">
            {list.map((row) => {
              const { tone, text } = pill(row);
              const error = errors[row.path];
              const isArmed = armed === row.path;
              return (
                <SettingRow
                  key={row.path}
                  as="li"
                  label={<span className="font-mono" title={row.path}>{row.branch ?? lastSegment(row.path)}</span>}
                  description={
                    error ? (
                      <span className="text-(--ui-err)" role="alert">{error}</span>
                    ) : (
                      [lastSegment(row.repo), row.reason, row.blocked && row.blocked !== "In use" ? row.blocked : null].filter(Boolean).join(" · ")
                    )
                  }
                >
                  <Status tone={tone}>{text}</Status>
                  <span className="ds-t-meta w-[4ch] text-right tabular-nums text-(--ui-ink-3)">{formatAge(row.lastActiveMs, now)}</span>
                  <span className="ds-t-meta w-[7ch] text-right font-mono tabular-nums text-(--ui-ink-3)">{formatSize(row.sizeBytes)}</span>
                  <Button
                    variant={isArmed ? "danger" : "ghost"}
                    size="sm"
                    disabled={busy || row.blocked !== null}
                    aria-label={isArmed ? "Discard work?" : `Remove ${row.branch ?? row.path}`}
                    title={row.blocked ?? undefined}
                    onClick={() => onRowRemove(row)}
                    icon={!isArmed}
                  >
                    {isArmed ? "Discard work?" : <Trash2 size={13} />}
                  </Button>
                </SettingRow>
              );
            })}
          </SettingsGroup>
        );
      })}

      {log.length > 0 ? (
        <SettingsGroup title="Removed · last 30 days" as="ul">
          {log.map((entry) => {
            const restore = restoreCommand(entry);
            return (
              <SettingRow
                key={`${entry.atMs}-${entry.path}`}
                as="li"
                label={<span className="font-mono">{entry.branch ?? lastSegment(entry.path)}</span>}
                description={`${lastSegment(entry.repo)} · ${new Date(entry.atMs).toLocaleString()}${entry.auto ? " · automatic" : ""}${entry.hadWork ? " · had work" : ""}`}
              >
                {restore ? (
                  <Button variant="ghost" size="sm" onClick={() => void copyTextToClipboard(restore).catch(() => undefined)}>
                    Copy restore command
                  </Button>
                ) : null}
              </SettingRow>
            );
          })}
        </SettingsGroup>
      ) : null}

      {preview ? (
        <Dialog
          title={`Remove ${summary.safe.length} worktrees · ${formatSize(summary.safeBytes)}`}
          description="Each folder and its local branch are removed. The removal log keeps a restore command."
          onClose={() => !busy && setPreview(false)}
          footer={
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(false)}>Cancel</Button>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove(summary.safe.map((r) => r.path), false)}>
                {busy ? "Removing…" : `Remove ${summary.safe.length}`}
              </Button>
            </>
          }
        >
          <ul className="flex max-h-[240px] flex-col gap-1.5 overflow-auto">
            {summary.safe.map((row) => (
              <li key={row.path} className="flex items-center gap-2">
                <Status tone={pill(row).tone}>{pill(row).text}</Status>
                <span className="min-w-0 flex-1 truncate font-mono" title={row.path}>{row.branch ?? lastSegment(row.path)}</span>
                <span className="ds-t-meta font-mono tabular-nums text-(--ui-ink-3)">{formatSize(row.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * One global rule, off by default: Merged or Clean, not in use, untouched for N days. Its own group,
 * so the "Saved" sign floats in the gap above the card instead of over a row.
 */
function AutoRule() {
  return (
    <SettingsSection label="Automatic cleanup">
      <SettingsFileSection>
      {(settings, update) => {
        const rule = readWorktreeCleanupSettings(settings);
        const set = (change: Partial<typeof rule>) => update({ worktreeCleanup: { ...rule, ...change } });
        return (
          <SettingRow label="Clean up automatically" description="Remove Merged or Clean worktrees not in use for">
            <NumberStepper
              label="Days unused"
              min={WORKTREE_CLEANUP_DAYS.min}
              max={WORKTREE_CLEANUP_DAYS.max}
              unit="days"
              value={rule.days}
              onChange={(days) => set({ days })}
            />
            <Switch checked={rule.auto} onChange={(auto) => set({ auto })} label="Clean up automatically" />
          </SettingRow>
        );
      }}
      </SettingsFileSection>
    </SettingsSection>
  );
}
