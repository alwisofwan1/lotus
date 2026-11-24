"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";
import { importCodeChatHistory } from "@/modules/chat/runtime/chat-runtime-client";

/**
 * "Import CodeChat history" (#290). CodeChat is gone, so the row only shows while it still has
 * chats to bring over, or right after an import or a failure to report the result.
 */
export function CodeChatImportRow() {
  const [pending, setPending] = useState<number | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    importCodeChatHistory(true)
      .then((report) => !cancelled && setPending(report.pending))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const report = await importCodeChatHistory(false);
      setImported(report.imported);
      setPending(report.pending - report.imported);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (pending === 0 && imported === null && error === null) return null;

  const chats = (n: number) => `${n} CodeChat ${n === 1 ? "chat" : "chats"}`;
  const hint = error ? (
    <span className="text-(--ui-err)">{error}</span>
  ) : imported !== null ? (
    <>
      <span className="text-(--ui-ok)">Imported {imported === 1 ? "1 chat" : `${imported} chats`}.</span> They’re
      in the thread list, in their folders.
    </>
  ) : pending === null ? (
    "Counting CodeChat chats…"
  ) : pending === 0 ? (
    "Every CodeChat chat is here."
  ) : (
    `${chats(pending)} ${pending === 1 ? "isn’t" : "aren’t"} in the new chat yet. CodeChat keeps its own copy.`
  );

  return (
    <SettingsGroup title="History">
      <SettingRow label="Import CodeChat history" description={hint}>
        <Button size="sm" disabled={busy || !pending} onClick={() => void run()}>
          {busy ? "Importing…" : "Import"}
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}
