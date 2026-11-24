"use client";

import { Check } from "lucide-react";
import { useMemo, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { getDesignTheme, getDesignThemeCssVars } from "@/lib/design-system";
import type { ThemeId, ThemePreference } from "@/lib/design-system";
import { themeRevealOrigin, type ThemeRevealOrigin } from "@/lib/design-system/theme-transition";

type ThemeModeOption = {
  id: ThemePreference;
  name: string;
  hint: string;
  /** The modes the preview draws, left to right. System shows both halves. */
  previews: ThemeId[];
};

export const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  { id: "system", name: "System", hint: "Follows macOS", previews: ["dark", "light"] },
  { id: "dark", name: "Dark", hint: "Warm, low glare", previews: ["dark"] },
  { id: "light", name: "Light", hint: "Paper, high contrast", previews: ["light"] },
];

// The mode's own tokens, scoped on the preview, so the preview is drawn by the same palette the app
// would switch to and cannot drift from it. Built once: the palettes are fixed, so every render
// can hand React the same style object.
const PREVIEW_VARS: Record<ThemeId, CSSProperties> = {
  dark: getDesignThemeCssVars(getDesignTheme("dark")) as CSSProperties,
  light: getDesignThemeCssVars(getDesignTheme("light")) as CSSProperties,
};

/** A mini app shell: sidebar on canvas, panel on bg, a heading, a muted line and a card. */
function ThemePreviewShell({ mode }: { mode: ThemeId }) {
  return (
    <span className="ds-theme-preview-shell" data-preview-mode={mode} style={PREVIEW_VARS[mode]}>
      <span className="ds-theme-preview-sidebar">
        <span />
        <span />
        <span />
      </span>
      <span className="ds-theme-preview-panel">
        <span className="ds-theme-preview-heading" />
        <span className="ds-theme-preview-muted" />
        <span className="ds-theme-preview-card">
          <span className="ds-theme-preview-card-line" />
          <span className="ds-theme-preview-card-status" />
        </span>
      </span>
    </span>
  );
}

export function ThemeModeCard({
  isSelected,
  onSelect,
  option,
  buttonRef,
}: {
  isSelected: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  option: ThemeModeOption;
  buttonRef?: (node: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={isSelected}
      tabIndex={isSelected ? 0 : -1}
      className="ds-theme-mode-card"
      data-mode={option.id}
      data-selected={isSelected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="ds-theme-mode-preview" aria-hidden="true">
        {option.previews.map((mode) => <ThemePreviewShell key={mode} mode={mode} />)}
      </span>

      <span className="ds-theme-mode-card-label">
        <span className="ds-theme-mode-card-body">
          <span className="ds-theme-mode-card-name">{option.name}</span>
          <span className="ds-theme-mode-card-desc">{option.hint}</span>
        </span>
        <span className="ds-theme-mode-card-check" aria-hidden="true">
          {isSelected ? <Check className="h-3 w-3" strokeWidth={2.5} /> : null}
        </span>
      </span>
    </button>
  );
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/** The three cards as one radio group: arrows move and select, Tab enters on the selected card. */
export function ThemeModeGroup({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (preference: ThemePreference, origin?: ThemeRevealOrigin) => void;
}) {
  const buttons = useRef(new Map<ThemePreference, HTMLButtonElement>());

  // One callback per card, kept across renders, so React does not detach and re-attach the refs.
  const refCallbacks = useMemo(
    () =>
      new Map(
        THEME_MODE_OPTIONS.map(({ id }) => [
          id,
          (node: HTMLButtonElement | null) => {
            if (node) buttons.current.set(id, node);
            else buttons.current.delete(id);
          },
        ]),
      ),
    [],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = THEME_MODE_OPTIONS.length - 1;
    const current = THEME_MODE_OPTIONS.findIndex((option) => option.id === value);
    let next: number;
    if (NEXT_KEYS.has(event.key)) next = current === last ? 0 : current + 1;
    else if (PREVIOUS_KEYS.has(event.key)) next = current === 0 ? last : current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    const { id } = THEME_MODE_OPTIONS[next];
    const button = buttons.current.get(id);
    onChange(id, themeRevealOrigin(button));
    button?.focus();
  };

  return (
    <div className="ds-theme-mode-grid" role="radiogroup" aria-label="Appearance" onKeyDown={onKeyDown}>
      {THEME_MODE_OPTIONS.map((option) => (
        <ThemeModeCard
          key={option.id}
          option={option}
          isSelected={value === option.id}
          onSelect={(event) => onChange(option.id, themeRevealOrigin(event.currentTarget, event))}
          buttonRef={refCallbacks.get(option.id)}
        />
      ))}
    </div>
  );
}
