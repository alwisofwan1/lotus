"use client";
import { useEffect, useState } from "react";
import {
  argsForLaunchMode,
  editorDisplayName,
  normalizeEditorSettings,
  type EditorLaunchMode,
  type EditorPreference,
} from "@/lib/editor-settings";
import { getEditorAvailability, type EditorAvailability } from "@/lib/tauri-api";
import type { ClaudeSettings } from "@/modules/settings/types";
import { SaveStatus } from "../components/SaveStatus";
import { SettingSelectRow } from "../components/SettingSelectRow";
import { SettingRow, SettingsGroup } from "../components/SettingsGroup";
import { Input } from "@/components/ui/field";
import { SettingToggleRow } from "../components/SettingToggleRow";
import { useSettingsFile } from "../hooks/useSettingsFile";

const NO_EDITORS: EditorAvailability = { vscode: false, cursor: false, antigravity: false, antigravityApp: false };

const LAUNCH_MODES: Array<{ value: EditorLaunchMode; label: string; example: string }> = [
  { value: "path", label: "Path only", example: "editor file.ts" },
  { value: "path-line", label: "Path:Line", example: "editor file.ts:12" },
  { value: "path-line-column", label: "Path:Line:Column", example: "editor file.ts:12:3" },
  { value: "goto-path-with-position", label: "--goto", example: "editor --goto file.ts:12:3" },
  { value: "line-flags", label: "Line flags", example: "editor file.ts --line 12 --column 3" },
];

/** The patch for picking an editor: the template editors get a working command and args to start from. */
function pickEditor(id: EditorPreference, current: ReturnType<typeof normalizeEditorSettings>): Partial<ClaudeSettings> {
  if (id === "antigravity") {
    return {
      editorPreference: id,
      editorLaunchMode: "path-line-column",
      editorCommand: current.editorCommand || "antigravity",
      editorArgs: current.editorArgs.length > 0 ? current.editorArgs : argsForLaunchMode("path-line-column"),
    };
  }
  if (id === "custom") {
    return {
      editorPreference: id,
      editorLaunchMode: "path",
      editorArgs: current.editorArgs.length > 0 ? current.editorArgs : argsForLaunchMode("path"),
    };
  }
  return { editorPreference: id };
}

/**
 * Lotus › Editor (was General): which editor a terminal file reference such as
 * `src/app/page.tsx:12` opens in. Read by Rust (`editor_opener.rs`) at each open, so a saved
 * change applies to the next click without a reload.
 */
export function EditorSection() {
  const { settings, update, state } = useSettingsFile();
  const [availability, setAvailability] = useState<EditorAvailability>(NO_EDITORS);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    getEditorAvailability().then(setAvailability).catch(() => setAvailability(NO_EDITORS));
  }, []);

  if (!settings) return <SaveStatus state={state} />;
  const editor = normalizeEditorSettings(settings);
  const usesTemplate = editor.editorPreference === "antigravity" || editor.editorPreference === "custom";
  const antigravityFound = availability.antigravity || availability.antigravityApp;
  const options: Array<{ value: EditorPreference; label: string }> = [
    { value: "system", label: "System default" },
    { value: "vscode", label: availability.vscode ? "VS Code" : "VS Code (not in PATH)" },
    { value: "cursor", label: availability.cursor ? "Cursor" : "Cursor (not in PATH)" },
    { value: "antigravity", label: antigravityFound ? "Antigravity" : "Antigravity (not installed)" },
    { value: "custom", label: "Custom command" },
  ];
  const launchMode = LAUNCH_MODES.find((m) => m.value === editor.editorLaunchMode) ?? LAUNCH_MODES[0];

  return (
    <div className="flex flex-col gap-6">
      <SaveStatus state={state} />
      <SettingsGroup title="Editor">
        <SettingSelectRow
          title="Open files in"
          description={<>Terminal file references like <code className="font-mono">src/app/page.tsx:12</code> open in {editorDisplayName(editor.editorPreference)}.</>}
          selectLabel="Editor"
          options={options}
          value={editor.editorPreference}
          onChange={(id) => update(pickEditor(id, editor))}
          footer={editor.editorPreference === "antigravity" && availability.antigravityApp && !availability.antigravity
            ? <>The app is installed, but the <code className="font-mono">antigravity</code> CLI is not in PATH.</>
            : undefined}
        />
      </SettingsGroup>

      {usesTemplate && (
        <SettingsGroup title="Launch command">
          <SettingSelectRow
            title="Launch style"
            description={<>How the file and position are passed, e.g. <code className="font-mono">{launchMode.example}</code>.</>}
            selectLabel="Launch style"
            options={LAUNCH_MODES.map(({ value, label }) => ({ value, label }))}
            value={launchMode.value}
            onChange={(mode) => update({ editorLaunchMode: mode, editorArgs: argsForLaunchMode(mode) })}
          />
          <CommitOnBlurField
            key={editor.editorCommand}
            label="Editor command"
            value={editor.editorCommand}
            placeholder={editor.editorPreference === "antigravity" ? "antigravity" : "zed"}
            onCommit={(value) => update({ editorCommand: value })}
          />
          <SettingToggleRow
            title="Advanced args"
            description="Only if the launch styles above are not enough."
            checked={advanced}
            onChange={setAdvanced}
          />
          {advanced && (
            <CommitOnBlurField
              key={editor.editorArgs.join("\n")}
              label="Editor args"
              multiline
              value={editor.editorArgs.join("\n")}
              placeholder={editor.editorPreference === "antigravity" ? "{pathWithPosition}" : "{path}\n--line\n{line}"}
              hint={<>One argument per line. Placeholders: <code className="font-mono">{"{path}"}</code>, <code className="font-mono">{"{line}"}</code>, <code className="font-mono">{"{column}"}</code>, <code className="font-mono">{"{pathWithPosition}"}</code>.</>}
              onCommit={(value) => update({ editorArgs: value.split("\n").map((arg) => arg.trim()).filter(Boolean) })}
            />
          )}
        </SettingsGroup>
      )}
    </div>
  );
}

/**
 * A text field that saves on blur or Enter, never per keystroke — a half-typed command is not a
 * setting. Callers key it by the saved value, so a new value from outside starts a fresh draft.
 */
function CommitOnBlurField({ label, value, placeholder, hint, multiline, onCommit }: {
  label: string;
  value: string;
  placeholder: string;
  hint?: React.ReactNode;
  multiline?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => { if (draft !== value) onCommit(draft); };

  if (multiline) {
    return (
      <SettingRow
        label={label}
        description={hint}
        body={
          <textarea
            aria-label={label}
            rows={4}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            className="ui-field w-full"
            data-mono=""
          />
        }
      />
    );
  }
  return (
    <SettingRow label={label} description={hint}>
      <Input
        mono
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        className="w-56"
      />
    </SettingRow>
  );
}
