"use client";
import { useEffect, useState } from "react";
import { getRemoteUsage } from "@/lib/tauri-api";
import { MODEL_DEFAULTS, getPaneTitleModelOptions } from "@/config/models";
import { isTauri } from "@/lib/tauri/runtime";
import { ClaudeAccount } from "@/modules/chat/ui/ChatAuth";
import { forgetChatModels } from "@/modules/chat/ui/ChatModel";
import { CHAT_FONTS, chatFontStyle, setChatFont, useChatFont } from "@/modules/chat/ui/chat-font";
import { NlModelKeyField } from "@/modules/codecanvas/components/settings/tabs/NlModelKeyField";
import { ChatApiProviders } from "@/modules/settings/components/ModelRegistrySection";
import { CodeChatImportRow } from "@/modules/settings/components/CodeChatImportRow";
import { CodeSpaceSettingsSection } from "@/modules/settings/components/CodeSpaceSettingsSection";
import { SettingSelectRow } from "../components/SettingSelectRow";
import { SettingToggleRow } from "../components/SettingToggleRow";
import { SettingsFileSection } from "../components/SettingsFileSection";
import { SettingsSection } from "../components/SettingsSection";
import { MoveOffCcs } from "./MoveOffCcs";
import { AntigravityLogin, Subscriptions } from "./Subscriptions";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { machineLabel } from "@/modules/workspace-shell/services/usage";

/** Code › CodeSpace: terminal runtime, pane titles and workbench editor, saved as you change them. */
export function CodeSpaceSection() {
  return <SettingsFileSection>{(settings, update) => <CodeSpaceSettingsSection settings={settings} update={update} />}</SettingsFileSection>;
}

/** Accounts: how each agent signs in, Chat's API providers, and the canvas command model's key. */
export function AccountsSection() {
  // Machines with an SSH connection open now: only those can be asked about their accounts.
  const [machines, setMachines] = useState<string[]>([]);
  useEffect(() => {
    getRemoteUsage()
      .then((all) => setMachines(all.filter((m) => m.state === "live").map((m) => m.target)))
      .catch(() => {});
  }, []);
  // "" = this Mac. A machine whose SSH connection closed falls back to this Mac.
  const [machine, setMachine] = useState("");
  const shownMachine = machines.includes(machine) ? machine : "";
  return (
    <div className="flex flex-col gap-6">
      {machines.length > 0 && (
        <SegmentedControl
          label="Machine"
          options={[{ value: "", label: "This Mac" }, ...machines.map((m) => ({ value: m, label: machineLabel(m) }))]}
          value={shownMachine}
          onChange={setMachine}
        />
      )}
      {/* One machine at a time; the key gives each its own list state. */}
      <Subscriptions key={`s-${shownMachine}`} target={shownMachine || null} />
      <MoveOffCcs key={`m-${shownMachine}`} target={shownMachine || null} />
      {/* Codex accounts are this Mac's only: a remote host lists Claude. */}
      {!shownMachine && <Subscriptions provider="codex" />}
      {!shownMachine && <AntigravityLogin />}
      <SettingsSection label="Agents · applies to the next chat">
        <ClaudeAccount />
      </SettingsSection>
      <SettingsSection label="API providers" description="OpenAI-compatible endpoints for the text-only API agent.">
        <ChatApiProviders onChange={forgetChatModels} />
      </SettingsSection>
      <NlModelKeyField />
    </div>
  );
}

/** The model that names a new chat from its first message. Saved to settings.json. */
function ChatTitles() {
  return (
    <SettingsFileSection>
      {(settings, update) => (
        <SettingsSection label="Titles">
          <SettingSelectRow
            title="Title model"
            description="Names conversations in Chat, Code panes and Canvas nodes"
            selectLabel="Conversation title model"
            options={getPaneTitleModelOptions().map(({ id, label }) => ({
              value: id,
              label: id === MODEL_DEFAULTS.chatTitle ? `${label} (default)` : label,
            }))}
            value={settings.chat?.titleModel ?? MODEL_DEFAULTS.chatTitle}
            onChange={(titleModel) => update({ chat: { ...settings.chat, titleModel } })}
          />
        </SettingsSection>
      )}
    </SettingsFileSection>
  );
}

/** The font of chat text (saved on this Mac, applied at once), and how agents reply (settings.json). */
function ChatReading() {
  const font = useChatFont();
  const face = CHAT_FONTS.find((f) => f.value === font) ?? CHAT_FONTS[0];
  return (
    <SettingsSection label="Reading">
      <SettingSelectRow
        title="Chat font"
        description={face.hint}
        selectLabel="Chat font"
        options={CHAT_FONTS.map(({ value, label }) => ({ value, label }))}
        value={font}
        onChange={setChatFont}
        footer={
          // A neutral sample, so it never reads as a real notice: a pangram, the letters that get mixed
          // up in file names, and one inline code span.
          <figure className="m-0">
            <p
              data-testid="chat-font-preview"
              className="m-0 text-(--ui-ink)"
              style={{ ...chatFontStyle(font), fontFamily: "var(--chat-read-font)", fontSize: "calc(15px * var(--chat-read-scale))", lineHeight: 1.65 }}
            >
              The quick brown fox jumps over the lazy dog. Il1 0O — <code className="font-mono text-[0.85em]">src/app.tsx</code>
            </p>
          </figure>
        }
      />
      <SettingsFileSection>
        {(settings, update) => (
          <SettingToggleRow
            title="Concise replies"
            description="One-line outcome, then Did · Stuck · Status · Next"
            checked={settings.chat?.conciseReplies === true}
            onChange={(conciseReplies) => update({ chat: { ...settings.chat, conciseReplies } })}
          />
        )}
      </SettingsFileSection>
    </SettingsSection>
  );
}

/** Chat: title model, reading and replies, and the CodeChat import while anything is left to import. */
export function ChatSection() {
  return (
    <div className="flex flex-col gap-6">
      <ChatTitles />
      <ChatReading />
      {isTauri() ? <CodeChatImportRow /> : null}
    </div>
  );
}
