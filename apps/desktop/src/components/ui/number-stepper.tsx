"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

// − value + for a bounded number. Each digit is a 0–9 column that springs to its new place, so only
// the digits that change move. Adapted from Planes' free Number Stepper
// (useplanes.com/r/number-stepper.json); four deliberate departures:
//
// - THE VALUE STAYS TYPEABLE. Planes' value is a read-only spinbutton. A settings field that cannot
//   take "750" without 30 clicks is a regression, so the value is a real input: the rolling digits
//   are drawn over it whenever no edit is in progress (at rest, and after an arrow key or Enter
//   while focused), and step aside while one is. A typed value is clamped on commit
//   (blur or Enter), never per keystroke — clamping "4" while the user is typing "40" would fight them.
// - BOUNDS ARE REQUIRED. Planes defaults to 0–999. A default range is an invented limit; the caller
//   states the real one, and the ends disable exactly there.
// - NO COLOURS, NO BLUR. Skin is `.ui-stepper*` in styles/design-system.css on Lotus tokens; Planes'
//   motion blur is dropped for the same reasons as SegmentedControl's.
// - HOLD TO REPEAT. Planes steps once per click. A 0–1000 range at step 25 is 40 clicks, so holding
//   a button repeats after a pause, and stops at the bound.
//
// Under reduced motion the digits swap instantly and the buttons do not scale.
//
// OPTIONAL MODE (`empty`): for a setting where no value is itself a value — "the role's default",
// "no cap". The value may be null, and null is drawn as what it means, muted. + from empty starts at
// `empty.start` (a real default from the backend) or the minimum; − at the minimum, or clearing the
// typed text, returns to empty. Without `empty` the stepper never produces null.
//
// SNAP (`snap`): steps land on multiples of `step` (20 → 25, 22 → 25, 22 → 20) instead of adding to
// whatever was typed, so 1–240 by 5 does not walk 1, 6, 11 …. Typing still keeps any whole number.

const DIGIT_SPRING = { stiffness: 280, damping: 22, mass: 0.7 } as const;
const PRESS = { scale: 0.92, transition: { type: "spring", stiffness: 1000, damping: 15 } } as const;
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 70;
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

interface StepperBase {
  min: number;
  max: number;
  step?: number;
  /** Accessible name of the field; the buttons read "Decrease …" / "Increase …". */
  label: string;
  /** Shown after the value, e.g. "ms". Not part of the value. */
  unit?: string;
  className?: string;
  /** Steps land on multiples of `step`. */
  snap?: boolean;
  /** PageUp / PageDown jump; 10 steps by default. */
  page?: number;
}

/** What an empty value means, and where + starts from it. */
export interface StepperEmpty {
  label: string;
  /** The value + gives an empty field; the minimum when absent. */
  start?: number;
}

export type NumberStepperProps =
  | (StepperBase & { value: number; onChange: (next: number) => void; empty?: undefined })
  | (StepperBase & { value: number | null; onChange: (next: number | null) => void; empty: StepperEmpty });

type Change = (next: number | null) => void;

export function NumberStepper(props: NumberStepperProps) {
  const { value, min, max, step = 1, label, unit, className, snap = false, empty } = props;
  const onChange = props.onChange as Change;
  const page = props.page ?? step * 10;
  const reduced = useReducedMotion() ?? false;
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  // Held buttons repeat from a timer, so they read the latest value through a ref, not a closure.
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });
  const set = (next: number | null) => {
    if (next === latest.current.value) return;
    latest.current.value = next;
    latest.current.onChange(next);
  };
  /** The value `by` away from `v`: on the `by` grid when snapping, clamped, or empty below the minimum. */
  const target = (v: number | null, by: number): number | null => {
    if (v === null) return by > 0 ? clamp(empty?.start ?? min) : null;
    if (by < 0 && empty && v <= min) return null;
    const size = Math.abs(by);
    const raw = snap ? (by > 0 ? Math.floor(v / size) * size + size : Math.ceil(v / size) * size - size) : v + by;
    return clamp(raw);
  };
  const nudge = (by: number) => set(target(latest.current.value, by));

  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    const parsed = Number(text);
    setDraft(null);
    if (text === "") {
      if (empty) onChange(null);
      return;
    }
    if (!Number.isFinite(parsed)) return;
    const next = clamp(parsed);
    if (next !== value) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const jump: Record<string, () => void> = {
      ArrowUp: () => nudge(step),
      ArrowDown: () => nudge(-step),
      PageUp: () => nudge(page),
      PageDown: () => nudge(-page),
      Home: () => set(min),
      End: () => set(max),
    };
    if (event.key === "Enter") {
      commit();
      return;
    }
    const act = jump[event.key];
    if (!act) return;
    event.preventDefault();
    setDraft(null);
    act();
  };

  const isEmpty = value === null;
  // Empty and not being typed into: the meaning is drawn in place of digits.
  const showEmpty = isEmpty && (draft === null || draft === "");

  return (
    <div role="group" aria-label={label} data-motion={reduced ? "reduced" : "full"} className={cn("ui-stepper", className)}>
      <StepButton label={`Decrease ${label}`} disabled={isEmpty || (!empty && value <= min)} reduced={reduced} onStep={() => nudge(-step)}>
        <Minus size={13} strokeWidth={2.25} />
      </StepButton>
      <span className="ui-stepper__field">
        <span
          className="ui-stepper__value"
          data-rolling={draft === null && !isEmpty ? "" : undefined}
          data-empty={showEmpty ? "" : undefined}
        >
          <input
            className="ui-stepper__input"
            type="text"
            inputMode="numeric"
            role="spinbutton"
            aria-label={label}
            aria-valuenow={value ?? undefined}
            aria-valuetext={isEmpty ? empty?.label : undefined}
            aria-valuemin={min}
            aria-valuemax={max}
            value={draft ?? (isEmpty ? "" : String(value))}
            onFocus={() => setDraft(isEmpty ? "" : String(value))}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
          />
          {showEmpty ? (
            <span className="ui-stepper__empty" aria-hidden>
              {empty?.label}
            </span>
          ) : draft === null && !isEmpty ? (
            <RollingNumber value={value} reduced={reduced} />
          ) : null}
        </span>
        {unit && !showEmpty ? (
          <span className="ui-stepper__unit" aria-hidden>
            {unit}
          </span>
        ) : null}
      </span>
      <StepButton label={`Increase ${label}`} disabled={!isEmpty && value >= max} reduced={reduced} onStep={() => nudge(step)}>
        <Plus size={13} strokeWidth={2.25} />
      </StepButton>
    </div>
  );
}

function StepButton({
  label,
  disabled,
  reduced,
  onStep,
  children,
}: {
  label: string;
  disabled: boolean;
  reduced: boolean;
  onStep: () => void;
  children: ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  // A bound reached mid-hold disables the button, which fires no pointerup: stop here instead.
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);

  const repeat = () => {
    onStep();
    timer.current = setTimeout(repeat, REPEAT_EVERY_MS);
  };

  return (
    <motion.button
      type="button"
      className="ui-stepper__btn"
      aria-label={label}
      disabled={disabled}
      whileTap={reduced || disabled ? undefined : PRESS}
      onPointerDown={(event) => {
        if (event.button !== 0 || disabled) return;
        onStep();
        timer.current = setTimeout(repeat, REPEAT_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // Pointer presses step on pointerdown; a click with detail 0 is the keyboard (Enter/Space).
      onClick={(event) => {
        if (event.detail === 0) onStep();
      }}
    >
      {children}
    </motion.button>
  );
}

function RollingNumber({ value, reduced }: { value: number; reduced: boolean }) {
  const text = String(value);
  if (reduced) {
    return (
      <span className="ui-stepper__digits" aria-hidden>
        {text}
      </span>
    );
  }
  // Keyed from the right, so the ones column stays the ones column when 975 becomes 1000.
  const chars = text.split("").map((char, i) => ({ char, key: `${text.length - i}` }));
  return (
    <span className="ui-stepper__digits" aria-hidden>
      <AnimatePresence mode="popLayout" initial={false}>
        {chars.map(({ char, key }) =>
          char >= "0" && char <= "9" ? (
            <motion.span
              key={key}
              layout="position"
              className="ui-stepper__digit"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <DigitColumn digit={Number(char)} />
            </motion.span>
          ) : (
            <span key={key + char} className="ui-stepper__digit">
              {char}
            </span>
          ),
        )}
      </AnimatePresence>
    </span>
  );
}

function DigitColumn({ digit }: { digit: number }) {
  const y = useSpring(digit, DIGIT_SPRING);
  useEffect(() => {
    y.set(digit);
  }, [digit, y]);
  const offset = useTransform(y, (v) => `${-v}em`);
  return (
    <motion.span className="ui-stepper__column" style={{ y: offset }}>
      {DIGITS.map((n) => (
        <span key={n}>{n}</span>
      ))}
    </motion.span>
  );
}
