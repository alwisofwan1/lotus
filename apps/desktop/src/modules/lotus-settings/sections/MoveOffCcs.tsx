"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { planCcsMigration, removeCcsMcpEntries, runCcsMigration, type CcsMigrationPlan } from "@/lib/tauri-api";
import { machineLabel } from "@/modules/workspace-shell/services/usage";
import { SettingRow, SettingsGroup } from "../components/SettingsGroup";

/**
 * Settings › Accounts › Move off ccs (plans/portable-accounts/issues/08): what the migration will do, run on
 * confirm, then what is left for the operator. Shown only while `~/.ccs` exists.
 */
export function MoveOffCcs({ target = null }: { target?: string | null }) {
  const [plan, setPlan] = useState<CcsMigrationPlan | null>(null);
  const [armed, setArmed] = useState<"run" | "mcp" | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    planCcsMigration(target)
      .then(setPlan)
      .catch((e: unknown) => setError(String(e)));
  }, [target]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!plan) return null;
  const relinks = plan.relinks.filter((r) => r.to !== null);
  const collisions = plan.merges.reduce((n, m) => n + m.collisions, 0);
  const left = plan.relinks.filter((r) => r.to === null);

  const act = (what: "run" | "mcp", action: () => Promise<unknown>) => {
    if (armed !== what) return setArmed(what);
    setArmed(null);
    setBusy(true);
    setError(null);
    action()
      .then(load)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const move = () =>
    act("run", async () => {
      const result = await runCcsMigration(target);
      setDone(`Moved. Backup: ${result.backup}`);
    });

  return (
    <SettingsGroup
      title={target ? `Move off ccs · ${machineLabel(target)}` : "Move off ccs"}
      description="Merges ccs's chats and memory into ~/.claude and points each ccs account there. Accounts stay where they are, so they stay signed in."
      footer={
        error ? (
          <span className="text-(--ui-err)" role="alert">
            {error}
          </span>
        ) : undefined
      }
    >
      {relinks.length > 0 ? (
        <SettingRow
          label="Move off ccs"
          description="Close every ccs session first. Uninstall ccs right after, before it starts again."
          body={
            <ul className="m-0 list-disc pl-5 ds-t-meta leading-relaxed text-(--ui-ink-3)">
              <li>
                {plan.merges.length} folders merged into ~/.claude
                {collisions > 0 && ` (${collisions} files on both sides: newer kept, the other beside it as .lotus-recovered; memory indexes combined)`}
              </li>
              <li>{relinks.length} links re-pointed to ~/.claude</li>
              {plan.defaultAccount && <li>Lotus starts new work as {plan.defaultAccount} (ccs&apos;s default)</li>}
              <li className="truncate" title={plan.backup}>
                Backup first: {plan.backup} (a few minutes)
              </li>
            </ul>
          }
        >
          <Button variant={armed === "run" ? "danger" : "secondary"} size="sm" disabled={busy} onClick={move}>
            {busy ? "Backing up and moving…" : armed === "run" ? "Move now?" : "Move off ccs…"}
          </Button>
        </SettingRow>
      ) : (
        <SettingRow
          label={done ?? "Moved off ccs"}
          description={
            <>
              Left for you: uninstall ccs; remove its lines from your shell profile; keep ~/.ccs/instances (the accounts live there).
              {left.length > 0 && <span className="block">Not moved (nothing outside ~/.ccs to point at): {left.map((r) => r.link).join(", ")}</span>}
            </>
          }
        />
      )}
      {plan.mcpEntries.length > 0 && (
        <SettingRow
          label="ccs MCP servers"
          description={
            <>
              {[...new Set(plan.mcpEntries.map((e) => e.name))].join(", ")} in {new Set(plan.mcpEntries.map((e) => e.file)).size} configs.
              Close Claude sessions first: they rewrite these files too. Each original is kept as .before-ccs-mcp-removal.
            </>
          }
        >
          <Button variant={armed === "mcp" ? "danger" : "secondary"} size="sm" disabled={busy} onClick={() => act("mcp", () => removeCcsMcpEntries(target))}>
            {armed === "mcp" ? "Remove them?" : "Remove…"}
          </Button>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}
