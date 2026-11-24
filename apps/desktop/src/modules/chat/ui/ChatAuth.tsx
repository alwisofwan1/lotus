"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { SettingRow } from "@/modules/lotus-settings/components/SettingsGroup";
import { SettingSegmentedRow } from "@/modules/lotus-settings/components/SettingSegmentedRow";
import type { AuthSource } from "../domain/thread-event";
import {
  getChatAuth,
  removeChatApiKey,
  saveChatApiKey,
  setChatAuthMode,
  type ChatAuthView,
  type Runner,
} from "../runtime/chat-runtime-client";
import { forgetChatModels } from "./ChatModel";
import { acpAgent } from "../providers/acp/agents";

// How each agent signs in lives in Settings › Chat › Accounts; a chat only shows, under its model
// picker, what the agent reported it used. A change applies to new sessions only.

/** The model picker's sign-in line: what the agent used; null before it reports, or for "api". */
export function accountLine(runner: Runner, reported: AuthSource, requested: AuthSource | null): { label: string; mismatch: boolean } | null {
  if (runner === "api" || reported === "unknown") return null;
  if (runner === "codex") return { label: reported === "apiKey" ? "OpenAI API key" : "ChatGPT login", mismatch: false };
  const acp = acpAgent(runner);
  if (acp) return { label: acp.authLabel, mismatch: false };
  if (requested !== null && requested !== reported) {
    return { label: reported === "apiKey" ? "Used an API key, not your login" : "Used your login, not the API key", mismatch: true };
  }
  return { label: reported === "apiKey" ? "API key" : "Claude login", mismatch: false };
}

/** "/u/.lotus-dev/dev-secrets.json" → "dev-secrets.json"; the full path stays in the tooltip. */
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Claude: the login or a key kept in the Keychain (a file in a dev build). */
export function ClaudeAccount() {
  const [view, setView] = useState<ChatAuthView | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getChatAuth().then(setView, (reason) => setError(String(reason)));
  }, []);

  const run = async (change: Promise<ChatAuthView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await change);
      setDraft("");
      setEditing(false);
      // Claude lists the models of the current sign-in.
      forgetChatModels();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const mode = view?.mode === "apiKey" ? "apiKey" : "login";
  const hint = view?.keyHint ?? null;
  // Picking "API key" with no key yet shows the field; the setting moves only once a key is saved.
  const pending = editing && !hint;
  const shown = pending ? "apiKey" : mode;
  const where = view?.storedInFile ? `Dev build file · ${fileName(view.storedInFile)}` : "macOS Keychain";

  return (
    <SettingSegmentedRow
      title="Claude"
      description={pending ? "Paste a key to switch to it" : mode === "apiKey" ? "Using your API key · billed per token" : "Using your Claude login · your subscription"}
      options={[
        { value: "login", label: "Claude login" },
        { value: "apiKey", label: "API key" },
      ]}
      value={shown}
      disabled={busy || !view}
      onChange={(next) => {
        setError(null);
        if (next === shown) return;
        if (next === "login" && pending) return setEditing(false);
        if (next === "apiKey" && !hint) return setEditing(true);
        void run(setChatAuthMode(next));
      }}
      footer={
        (hint || editing || error) && (
          <div className="flex flex-col gap-1.5">
            {hint && !editing ? (
              <div className="flex items-center gap-2 ds-t-meta">
                <code className="font-mono text-(--ui-ink)">sk-ant-…{hint}</code>
                <span className="text-(--ui-ink-3)" title={view?.storedInFile ?? undefined}>
                  {where}
                </span>
                <span className="ml-auto flex gap-1.5">
                  <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
                    Replace
                  </Button>
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => void run(removeChatApiKey())}>
                    Remove
                  </Button>
                </span>
              </div>
            ) : (
              editing && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.trim()) void run(saveChatApiKey(draft));
                  }}
                >
                  <Input
                    mono
                    type="password"
                    className="flex-1"
                    aria-label="Anthropic API key"
                    placeholder="sk-ant-…"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => event.key === "Escape" && setEditing(false)}
                  />
                  <Button type="submit" variant="primary" size="sm" disabled={busy || !draft.trim()}>
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </form>
              )
            )}
            {editing && <span className="ds-t-meta text-(--ui-ink-3)">Kept in the {where}. Lotus never shows it again.</span>}
            {error && (
              <p className="m-0 ds-t-meta text-(--ui-err)" role="alert">
                {error}
              </p>
            )}
          </div>
        )
      }
    />
  );
}
