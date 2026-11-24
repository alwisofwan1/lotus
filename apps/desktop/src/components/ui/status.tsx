"use client";
import type { ReactNode } from "react";

export type StatusTone = "ok" | "warn" | "err" | "neutral";

/** Quiet status: a dot plus text, never a filled chip. `busy` pulses the dot. */
export function Status({ tone = "neutral", busy, children }: { tone?: StatusTone; busy?: boolean; children: ReactNode }) {
  return (
    <span className="ui-status" data-tone={tone} data-busy={busy ? "" : undefined}>
      {children}
    </span>
  );
}

/** Small meta label ("Default", "Beta"). `accent` for the one that should stand out. */
export function Tag({ accent, children }: { accent?: boolean; children: ReactNode }) {
  return (
    <span className="ui-tag" data-tone={accent ? "accent" : undefined}>
      {children}
    </span>
  );
}

/** Keyboard shortcut, one <kbd> per key. */
export function Kbd({ keys }: { keys: readonly string[] }) {
  return (
    <span className="ui-kbd">
      {keys.map((k, i) => (
        <kbd key={`${k}-${i}`}>{k}</kbd>
      ))}
    </span>
  );
}

/** 30px leading glyph tile for a list row. */
export function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="ui-tile" aria-hidden>
      {children}
    </span>
  );
}

/** "n of min" as a row of steps, for a count that has a floor ("needs 5 names"). */
export function MinMeter({ value, min }: { value: number; min: number }) {
  return (
    <span className="ui-meter" role="meter" aria-valuenow={Math.min(value, min)} aria-valuemin={0} aria-valuemax={min} aria-label={`${value} of ${min}`}>
      {Array.from({ length: min }, (_, i) => (
        <i key={i} data-filled={i < value ? "" : undefined} />
      ))}
    </span>
  );
}
