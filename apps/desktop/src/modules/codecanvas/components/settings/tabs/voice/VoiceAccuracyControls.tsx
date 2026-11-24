"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { SettingRow } from "@/modules/lotus-settings/components/SettingsGroup";
import { useVoiceAccuracySettings } from "@/modules/codecanvas/hooks/useVoiceAccuracySettings";
import { resolveSttExpectedLanguages } from "@/modules/codecanvas/services/voice/stt-hint";

/** Local-only personal vocabulary and literal correction editor for classic push-to-talk STT. */
export function VoiceAccuracyControls() {
  const accuracy = useVoiceAccuracySettings();
  const [languages, setLanguages] = useState(accuracy.expectedLanguages.join(", "));
  const [terms, setTerms] = useState(accuracy.personalTerms.join("\n"));
  const [variants, setVariants] = useState("");
  const [replacement, setReplacement] = useState("");
  const deviceLanguages = resolveSttExpectedLanguages([]);

  const persistCore = (nextLanguages = languages, nextTerms = terms) => {
    accuracy.setSettings({
      ...accuracy,
      expectedLanguages: nextLanguages.split(",").map((value) => value.trim()).filter(Boolean),
      personalTerms: nextTerms.split("\n").map((value) => value.trim()).filter(Boolean),
    });
  };

  const addCorrection = () => {
    const candidates = variants.split(",").map((value) => value.trim()).filter(Boolean);
    if (candidates.length === 0 || !replacement.trim()) return;
    accuracy.setSettings({
      personalTerms: terms.split("\n").map((value) => value.trim()).filter(Boolean),
      expectedLanguages: languages.split(",").map((value) => value.trim()).filter(Boolean),
      replacements: [...accuracy.replacements, {
        id: globalThis.crypto?.randomUUID?.() ?? `replacement-${Date.now()}`,
        variants: candidates,
        replacement: replacement.trim(),
        timing: "both",
        enabled: true,
      }],
    });
    setVariants("");
    setReplacement("");
  };

  return (
    <SettingRow
      label="Recognition accuracy"
      description="Hints go only to the active engine; corrections run locally, word for word."
      body={
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="ds-t-meta font-medium text-(--ui-ink-3)">Expected languages</span>
            <Input
              aria-label="Expected languages"
              value={languages}
              placeholder="id, en"
              onChange={(event) => setLanguages(event.target.value)}
              onBlur={(event) => persistCore(event.target.value, terms)}
            />
            {languages.trim() === "" && deviceLanguages.length > 0 ? (
              <span className="ds-t-micro text-(--ui-ink-4)">Empty uses this device: {deviceLanguages.join(", ")}.</span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="ds-t-meta font-medium text-(--ui-ink-3)">Personal dictionary</span>
            <textarea
              aria-label="Personal dictionary"
              value={terms}
              rows={3}
              placeholder={"One exact spelling per line\nAGENTS.md\nClaude Code"}
              onChange={(event) => setTerms(event.target.value)}
              onBlur={(event) => persistCore(languages, event.target.value)}
              className="ui-field resize-y"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="ds-t-meta font-medium text-(--ui-ink-3)">Corrections</span>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Input
                aria-label="Misheard variants"
                value={variants}
                placeholder="clod code, cloud code"
                onChange={(event) => setVariants(event.target.value)}
                className="min-w-0"
              />
              <Input
                aria-label="Exact replacement"
                value={replacement}
                placeholder="Claude Code"
                onChange={(event) => setReplacement(event.target.value)}
                className="min-w-0"
              />
              <Button icon aria-label="Add correction" onClick={addCorrection}>
                <Plus size={15} />
              </Button>
            </div>
          </div>

          {accuracy.replacements.length > 0 && (
            <ul className="m-0 flex list-none flex-col overflow-hidden rounded-(--ui-r-md) bg-(--ui-fill) p-0">
              {accuracy.replacements.map((rule, i) => (
                <li key={rule.id} className={`flex items-center gap-2 py-1 pr-1 pl-3 ds-t-meta${i > 0 ? " border-t border-(--ui-line)" : ""}`}>
                  <span className="min-w-0 flex-1 truncate text-(--ui-ink-3)">{rule.variants.join(", ")}</span>
                  <span aria-hidden="true" className="text-(--ui-ink-4)">→</span>
                  <span className="truncate font-medium text-(--ui-ink)">{rule.replacement}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon
                    aria-label={`Remove correction ${rule.replacement}`}
                    onClick={() => accuracy.setSettings({
                      ...accuracy,
                      replacements: accuracy.replacements.filter((entry) => entry.id !== rule.id),
                    })}
                  >
                    <Trash2 size={13} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    />
  );
}
