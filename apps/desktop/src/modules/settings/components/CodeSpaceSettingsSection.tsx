"use client";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  normalizeTerminalFontSize,
  TERMINAL_FONT_SIZE_KEY,
} from "@/modules/codespace/services/terminal-settings";
import { CODESPACE_DARK_THEME, CODESPACE_LIGHT_THEME, EDITOR_THEME_OPTIONS } from "@/modules/codespace/services/monaco-theme";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  EDITOR_AUTO_SAVE_OPTIONS,
  readEditorPreferences,
} from "@/modules/codespace/services/editor-preferences";
import { useCanvasBehaviorSettings } from "@/modules/codecanvas/hooks/useCanvasBehaviorSettings";
import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";
import type { ClaudeSettings } from "@/modules/settings/types";
import { QuitChoiceRow } from "@/modules/settings/components/QuitChoiceRow";

const TERMINAL_FONT_SIZE_OPTIONS = [
  { value: 11, label: "11 px", description: "Dense" },
  { value: 12, label: "12 px", description: "Compact" },
  { value: 13, label: "13 px", description: "Ghostty-style" },
  { value: 14, label: "14 px", description: "Lotus default" },
  { value: 15, label: "15 px", description: "Comfortable" },
  { value: 16, label: "16 px", description: "Large" },
] as const;

const EDITOR_FONT_SIZE_OPTIONS = [11, 12, 13, 14, 15, 16, 18, 20] as const;

const EDITOR_FLAG_ROWS = [
  {
    preference: "formatOnSave",
    key: "editorFormatOnSave",
    title: "Format on save",
    description: "Uses the file's language server",
  },
  {
    preference: "trimTrailingWhitespace",
    key: "editorTrimTrailingWhitespace",
    title: "Trim trailing whitespace",
    description: "On save; Markdown is skipped",
  },
  {
    preference: "insertFinalNewline",
    key: "editorInsertFinalNewline",
    title: "Insert final newline",
    description: "A project's .editorconfig wins",
  },
  {
    preference: "minimap",
    key: "editorMinimap",
    title: "Minimap",
    description: "Overview of the file at the right edge",
  },
  {
    preference: "stickyScroll",
    key: "editorStickyScroll",
    title: "Sticky scroll",
    description: "Pins the current function or class header",
  },
  {
    preference: "inlineBlame",
    key: "editorInlineBlame",
    title: "Inline blame",
    description: "Who last changed the cursor's line, and when",
  },
] as const satisfies ReadonlyArray<{ preference: keyof ReturnType<typeof readEditorPreferences>; key: string; title: string; description: string }>;

export function CodeSpaceSettingsSection({
  settings,
  update,
}: {
  settings: ClaudeSettings;
  update: (patch: Partial<ClaudeSettings>) => void;
}) {
  const terminalFontSize = normalizeTerminalFontSize(settings[TERMINAL_FONT_SIZE_KEY]);
  const editorPreferences = readEditorPreferences(settings as Record<string, unknown>);
  const { terminalShiftEnterNewline, setBehavior } = useCanvasBehaviorSettings();

  const codespace = settings.codespace ?? {};
  const autoTitles = codespace.autoPaneTitles ?? true;

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title="Terminal">
        <SettingRow label="Terminal font size" description="CodeSpace terminal panes">
          <Select
            label="Terminal font size"
            value={String(terminalFontSize)}
            onChange={(next) => update({ [TERMINAL_FONT_SIZE_KEY]: Number(next) })}
            options={TERMINAL_FONT_SIZE_OPTIONS.map((o) => ({ value: String(o.value), label: `${o.label} — ${o.description}` }))}
          />
        </SettingRow>
        <SettingRow label="Shift+Enter inserts a newline" description="Canvas Terminal nodes; turn off for vim">
          <Switch
            label="Shift+Enter inserts a newline"
            checked={terminalShiftEnterNewline}
            onChange={(value) => setBehavior("terminalShiftEnterNewline", value)}
          />
        </SettingRow>
        <QuitChoiceRow />
      </SettingsGroup>

      <SettingsGroup title="Pane titles">
        <SettingRow label="Auto pane titles" description="Names each agent pane after its first turn, with the model set in Chat › Titles">
          <Switch
            label="Toggle automatic pane titles"
            checked={autoTitles}
            onChange={(value) => update({ codespace: { ...codespace, autoPaneTitles: value } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Editor">
        <CodeSpaceThemeSelect
          label="Dark theme"
          description="Syntax colors in dark mode"
          value={codespace.editorDarkTheme ?? CODESPACE_DARK_THEME}
          kind="dark"
          onChange={(editorDarkTheme) => update({ codespace: { ...codespace, editorDarkTheme } })}
        />
        <CodeSpaceThemeSelect
          label="Light theme"
          description="Syntax colors in light mode"
          value={codespace.editorLightTheme ?? CODESPACE_LIGHT_THEME}
          kind="light"
          onChange={(editorLightTheme) => update({ codespace: { ...codespace, editorLightTheme } })}
        />
        <SettingRow label="Editor font size" description="Editor pane and its diffs">
          <Select
            label="Editor font size"
            value={String(editorPreferences.fontSize)}
            onChange={(next) => update({ codespace: { ...codespace, editorFontSize: Number(next) } })}
            options={[...new Set([...EDITOR_FONT_SIZE_OPTIONS, editorPreferences.fontSize])]
              .sort((a, b) => a - b)
              .map((size) => ({ value: String(size), label: `${size} px${size === DEFAULT_EDITOR_FONT_SIZE ? " — default" : ""}` }))}
          />
        </SettingRow>
        <SettingRow label="Word wrap" description="Wrap long lines at the pane width">
          <Switch
            label="Toggle editor word wrap"
            checked={editorPreferences.wordWrap}
            onChange={(value) => update({ codespace: { ...codespace, editorWordWrap: value } })}
          />
        </SettingRow>
        <SettingRow label="Auto save" description="Saves after a pause or on focus change">
          <Select
            label="Editor auto save"
            value={editorPreferences.autoSave}
            onChange={(editorAutoSave) => update({ codespace: { ...codespace, editorAutoSave } })}
            options={EDITOR_AUTO_SAVE_OPTIONS}
          />
        </SettingRow>
        {EDITOR_FLAG_ROWS.map((row) => (
          <SettingRow key={row.key} label={row.title} description={row.description}>
            <Switch
              label={`Toggle editor ${row.title.toLowerCase()}`}
              checked={editorPreferences[row.preference]}
              onChange={(value) => update({ codespace: { ...codespace, [row.key]: value } })}
            />
          </SettingRow>
        ))}
        <SettingRow label="Language servers" description="Hover, errors, go to definition; only in trusted folders">
          <Switch
            label="Toggle editor language servers"
            checked={editorPreferences.languageServers}
            onChange={(value) => update({ codespace: { ...codespace, editorLanguageServers: value } })}
          />
        </SettingRow>
        <SettingRow
          label="Trusted folders"
          description={
            editorPreferences.trustedFolders.length === 0
              ? "No folders yet. The editor asks the first time a server could start."
              : "Language servers may run here and in subfolders"
          }
          body={
            editorPreferences.trustedFolders.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Trusted folders">
                {editorPreferences.trustedFolders.map((folder) => (
                  <li key={folder} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-mono ds-t-meta text-(--ui-ink-2)" title={folder}>
                      {folder}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Stop trusting ${folder}`}
                      onClick={() =>
                        update({
                          codespace: { ...codespace, editorTrustedFolders: editorPreferences.trustedFolders.filter((entry) => entry !== folder) },
                        })
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : undefined
          }
        />
      </SettingsGroup>
    </div>
  );
}

function CodeSpaceThemeSelect({
  label,
  description,
  value,
  kind,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  kind: "dark" | "light";
  onChange: (themeId: string) => void;
}) {
  return (
    <SettingRow label={label} description={description}>
      <Select
        label={`Editor ${kind} theme`}
        value={value}
        onChange={onChange}
        options={EDITOR_THEME_OPTIONS.filter((theme) => theme.kind === kind).map((theme) => ({ value: theme.id, label: theme.label }))}
      />
    </SettingRow>
  );
}
