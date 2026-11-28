"use client";
import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";
import {
  acquireCanvasHotkeyRecordingLease,
  CANVAS_HOTKEY_COMMANDS,
  createModifierOnlyHotkeyTracker,
  detectCanvasHotkeyPlatform,
  doesGlobalChordReplaceTyping,
  effectiveBindings,
  findChordConflict,
  findToolShortcutConflict,
  formatChord,
  isCommandChordTerminalSafe,
  isGlobalCanvasHotkeyCommand,
  modifierOnlyChordForEvent,
  normalizeChord,
  UNBOUND_CHORD,
  type CanvasHotkeyCommand,
  type CanvasHotkeyCommandId,
  type CanvasHotkeyGroup,
  type CanvasHotkeyPlatform,
} from "../../../services/canvas-hotkeys";
import { useCanvasHotkeyOverrides } from "../../../hooks/useCanvasHotkeySettings";

const GROUP_LABELS: Record<CanvasHotkeyGroup, string> = {
  navigation: "Navigation",
  layers: "Layers & framing",
  voice: "Voice",
  "app-voice": "Voice (all modes)",
  general: "General",
};
const GROUP_ORDER: CanvasHotkeyGroup[] = ["navigation", "layers", "voice", "app-voice", "general"];

const COMMAND_BY_ID = new Map<CanvasHotkeyCommandId, CanvasHotkeyCommand>(
  CANVAS_HOTKEY_COMMANDS.map((c) => [c.id, c]),
);

interface PendingConflict {
  id: CanvasHotkeyCommandId;
  chord: string;
  conflictId: CanvasHotkeyCommandId;
}

/** A recorded chord that's free in the registry but claimed by a whiteboard tool shortcut. */
interface PendingToolConflict {
  id: CanvasHotkeyCommandId;
  chord: string;
  tool: string;
}

export function HotkeysTab({ platform: platformProp }: { platform?: CanvasHotkeyPlatform } = {}) {
  const [platform] = useState<CanvasHotkeyPlatform>(platformProp ?? detectCanvasHotkeyPlatform);
  const { overrides, setOverride, clearOverride, resetAll } = useCanvasHotkeyOverrides();
  const [recordingId, setRecordingId] = useState<CanvasHotkeyCommandId | null>(null);
  const [pending, setPending] = useState<PendingConflict | null>(null);
  const [toolPending, setToolPending] = useState<PendingToolConflict | null>(null);

  const bindings = effectiveBindings(overrides);
  const hasOverrides = Object.keys(overrides).length > 0;

  useEffect(() => {
    if (!recordingId) return;
    const releaseRecordingLease = acquireCanvasHotkeyRecordingLease();
    const modifierTracker = createModifierOnlyHotkeyTracker();
    let finished = false;

    const commitChord = (chord: string) => {
      if (finished) return;
      finished = true;
      const conflictId = findChordConflict(chord, recordingId, overrides);
      if (conflictId) {
        setPending({ id: recordingId, chord, conflictId });
      } else {
        // Registry is clear, but the whiteboard tool listener lives outside the registry. Global
        // voice shortcuts capture first, so only ordinary Canvas commands can collide with a tool.
        const tool = isGlobalCanvasHotkeyCommand(recordingId) ? null : findToolShortcutConflict(chord);
        if (tool) setToolPending({ id: recordingId, chord, tool });
        else setOverride(recordingId, chord);
      }
      setRecordingId(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        finished = true;
        setRecordingId(null);
        return;
      }
      modifierTracker.keyDown(event);
      if (modifierOnlyChordForEvent(event)) return;
      commitChord(normalizeChord(event));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!modifierOnlyChordForEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const chord = modifierTracker.keyUp(event);
      if (chord) commitChord(chord);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      releaseRecordingLease();
      modifierTracker.reset();
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [recordingId, overrides, setOverride]);

  const conflictFixed = pending ? Boolean(COMMAND_BY_ID.get(pending.conflictId)?.fixed) : false;

  function reassign() {
    if (!pending) return;
    setOverride(pending.id, pending.chord);
    if (!conflictFixed) setOverride(pending.conflictId, UNBOUND_CHORD);
    setPending(null);
  }

  function bindDespiteToolConflict() {
    if (!toolPending) return;
    setOverride(toolPending.id, toolPending.chord);
    setToolPending(null);
  }

  const groups = GROUP_ORDER.filter((group) => CANVAS_HOTKEY_COMMANDS.some((c) => c.group === group));

  return (
    <div className="flex flex-col gap-6">
      {pending && (
        <div className="canvas-hotkey-conflict" role="alert">
          <span className="canvas-hotkey-conflict-msg">
            <strong>{formatChord(pending.chord, platform).join(" ")}</strong> is already used by{" "}
            <strong>{COMMAND_BY_ID.get(pending.conflictId)?.title}</strong>
            {conflictFixed ? " (reserved)." : "."}
          </span>
          <span className="canvas-hotkey-conflict-acts">
            {!conflictFixed && (
              <Button variant="primary" size="sm" onClick={reassign}>
                Reassign anyway
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}

      {toolPending && (
        <div className="canvas-hotkey-conflict" role="alert">
          <span className="canvas-hotkey-conflict-msg">
            <strong>{formatChord(toolPending.chord, platform).join(" ")}</strong> already switches to
            the <strong>{toolPending.tool}</strong> tool on the whiteboard — binding it here means
            both would fire.
          </span>
          <span className="canvas-hotkey-conflict-acts">
            <Button variant="primary" size="sm" onClick={bindDespiteToolConflict}>
              Bind anyway
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setToolPending(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}

      {groups.map((group, index) => (
        <SettingsGroup
          key={group}
          title={GROUP_LABELS[group]}
          description={
            index === 0 ? "Click one, then press keys. A lone modifier works too; left and right modifiers stay separate." : undefined
          }
          action={
            index === 0 ? (
              <Button variant="ghost" size="sm" onClick={resetAll} disabled={!hasOverrides}>
                <RotateCcw size={13} />
                Reset all to default
              </Button>
            ) : undefined
          }
          as="ul"
        >
          {CANVAS_HOTKEY_COMMANDS.filter((c) => c.group === group).map((cmd) => {
            const chord = bindings[cmd.id];
            const recording = recordingId === cmd.id;
            const unbound = chord === UNBOUND_CHORD;
            const safe = !unbound && isCommandChordTerminalSafe(cmd.id, chord);
            const globalCommand = isGlobalCanvasHotkeyCommand(cmd.id);
            const replacesTyping = globalCommand && !unbound && doesGlobalChordReplaceTyping(chord);
            return (
              <li key={cmd.id} className="ui-row-item" data-hotkey-row={cmd.id}>
                <div className="ui-row">
                  <div className="ui-row-text">
                    <span className="ui-row-label">{cmd.title}</span>
                    {!cmd.fixed && (
                      <span className={`ui-row-desc${safe || globalCommand ? "" : " text-(--ui-warn)"}`}>
                        {globalCommand
                          ? replacesTyping
                            ? "global: replaces typing for this key while Canvas is open"
                            : "global shortcut"
                          : safe
                            ? "terminal-safe"
                            : "canvas-layer only: a focused terminal keeps this key"}
                      </span>
                    )}
                  </div>
                  <div className="ui-row-ctl">
                    {cmd.id in overrides && (
                      <Button variant="ghost" size="sm" icon aria-label={`${cmd.title} reset`} title="Reset to default" onClick={() => clearOverride(cmd.id)}>
                        <RotateCcw size={13} />
                      </Button>
                    )}
                    <Button
                      variant={recording ? "primary" : "secondary"}
                      size="sm"
                      className={cmd.fixed ? "cursor-default opacity-60" : undefined}
                      aria-label={`${cmd.title} binding`}
                      aria-disabled={cmd.fixed || undefined}
                      onClick={() => {
                        if (cmd.fixed) return;
                        setPending(null);
                        setToolPending(null);
                        setRecordingId(cmd.id);
                      }}
                    >
                      {recording ? (
                        "Press keys or release one modifier… Esc cancels"
                      ) : unbound ? (
                        <span className="text-(--ui-ink-4)">Unassigned</span>
                      ) : (
                        <span className="ui-kbd">
                          {formatChord(chord, platform).map((cap, i) => (
                            <kbd key={i}>{cap}</kbd>
                          ))}
                        </span>
                      )}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </SettingsGroup>
      ))}
    </div>
  );
}
