"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

import { MenuItem, MenuLabel, ResourceMenu } from "@/components/resource/resource-kit";
import type { Verdict } from "../services/automation-api";

const CHOICES: { value: Verdict; label: string }[] = [
  { value: "looks-good", label: "LGTM" },
  { value: "questions", label: "Questions" },
  { value: "changes-needed", label: "Changes needed" },
];

/**
 * The verdict as one segmented control. A decision edits the draft; publishing is always a separate
 * action. Suggestions never raise the minimum. LGTM over line findings asks once to turn them into
 * suggestions (`downgradable`); findings off the diff or still open from an earlier round cannot be
 * turned here, so LGTM stays closed while they remain.
 */
export function ReviewDecision({ verdict, minimum, locked, downgradable, onChange, onDowngrade, variant = "segmented" }: {
  /** `chip`: one chip under the title, the choices in its menu (the Dock's quiet list, 16b v2). */
  variant?: "segmented" | "chip";
  verdict: Verdict;
  minimum: Verdict;
  locked: boolean;
  /** Line findings that hold LGTM back, when they are all that does; 0 otherwise. */
  downgradable: number;
  onChange: (verdict: Verdict) => void;
  /** Turns those findings into suggestions and chooses LGTM. */
  onDowngrade: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const id = useId();
  const blocked = (next: Verdict) =>
    next === "looks-good" ? minimum !== "looks-good" && downgradable === 0 : next === "questions" && minimum === "changes-needed";
  const choose = (next: Verdict) => {
    if (next === "looks-good" && minimum !== "looks-good") {
      setAsking(true);
      return;
    }
    setAsking(false);
    onChange(next);
  };
  const findings = `${downgradable} finding${downgradable === 1 ? "" : "s"}`;
  const callout = asking ? (
    <div className="au-callout" role="alertdialog" aria-label="Turn findings into suggestions">
      <p>Turn {findings} into {downgradable === 1 ? "a suggestion" : "suggestions"}? The author may skip a suggestion.</p>
      <span className="au-draft-actions">
        <button type="button" className="rs-button rs-button--ghost" onClick={() => setAsking(false)}>Cancel</button>
        <button type="button" className="rs-button rs-button--primary" onClick={() => { setAsking(false); onDowngrade(); }}>
          Turn into {downgradable === 1 ? "suggestion" : "suggestions"}
        </button>
      </span>
    </div>
  ) : null;
  if (variant === "chip") {
    const current = CHOICES.find((c) => c.value === verdict) ?? CHOICES[0];
    return (
      <section className="au-decision au-decision--chip" aria-label="Your decision">
        <ResourceMenu
          className="au-verdict"
          align="start"
          label={`Verdict: ${current.label}. Change it`}
          trigger={
            <span className="au-verdict-chip" data-verdict={verdict}>
              <span className="au-verdict-dot" aria-hidden />
              {current.label}
              <ChevronDown size={12} aria-hidden />
            </span>
          }
        >
          <MenuLabel>Verdict</MenuLabel>
          {CHOICES.map((choice) => (
            <MenuItem key={choice.value} checked={verdict === choice.value} disabled={locked || blocked(choice.value)} onSelect={() => choose(choice.value)}>
              {choice.label}
            </MenuItem>
          ))}
          {minimum !== "looks-good" && downgradable === 0 ? <MenuLabel>LGTM opens when the remaining findings are resolved.</MenuLabel> : null}
        </ResourceMenu>
        {callout}
      </section>
    );
  }
  return (
    <section className="au-decision" aria-label="Your decision">
      <span className="au-label">Verdict</span>
      <div className="au-segmented" role="group" aria-label="Review verdict">
        {CHOICES.map((choice) => (
          <button type="button" key={choice.value} className="au-segment" data-verdict={choice.value}
            aria-label={choice.label} aria-pressed={verdict === choice.value}
            disabled={locked || blocked(choice.value)} aria-describedby={blocked(choice.value) ? `${id}-help` : undefined}
            onClick={() => choose(choice.value)}>
            {choice.label}
          </button>
        ))}
      </div>
      {callout}
      {minimum !== "looks-good" && downgradable === 0 ? (
        <p id={`${id}-help`} className="au-hint">LGTM opens when the remaining findings are resolved. Findings off the diff and earlier open findings count too.</p>
      ) : null}
    </section>
  );
}
