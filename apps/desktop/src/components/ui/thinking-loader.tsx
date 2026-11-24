"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// A pill that says what an agent is doing right now: a spinner, the activity label with a light
// sweeping across it, and an optional quiet detail (elapsed time). When the label changes the pill
// springs to its new width and the old label hands over to the new one. Adapted from Planes' free
// Thinking Loader (useplanes.com/r/thinking-loader.json); three deliberate departures:
//
// - NO SCRIPTED PHASES. Planes cycles "Searching the web / Reading sources / Writing response" on a
//   timer, whatever the model is actually doing. In a developer tool that is a lie the user acts on,
//   so this component takes `label` from the caller and never invents one.
// - NO COLOURS. The skin is `.ui-thinking*` in styles/design-system.css, driven by
//   `--ui-thinking-dim` / `--ui-thinking-bright`, so each surface maps it to its own tokens.
// - THE LIVE REGION ANNOUNCES THE LABEL ONLY. The detail ticks every second; inside the live region
//   it would make a screen reader read the clock aloud, so it is aria-hidden.
//
// Under reduced motion the spinner stands still, there is no sweep, and labels swap instantly.

const SPRING_WIDTH = { type: "spring", stiffness: 400, damping: 30, mass: 0.8 } as const;
const LABEL_IN = { duration: 0.32, ease: [0.22, 1, 0.36, 1] } as const;
const LABEL_OUT = { duration: 0.14, ease: "easeOut" } as const;

export interface ThinkingLoaderProps {
  /** What is happening now, from real state — never a guess. */
  label: string;
  /** Secondary, non-announced text such as elapsed time. */
  detail?: string;
  className?: string;
}

export function ThinkingLoader({ label, detail, className }: ThinkingLoaderProps) {
  const reduced = useReducedMotion() ?? false;

  return (
    <motion.div
      layout={!reduced}
      transition={SPRING_WIDTH}
      role="status"
      aria-live="polite"
      data-motion={reduced ? "reduced" : "full"}
      className={cn("ui-thinking", className)}
    >
      <motion.span layout={reduced ? false : "position"} aria-hidden className="ui-thinking__icon">
        <Loader2 size={14} strokeWidth={2} />
      </motion.span>
      <motion.span layout={reduced ? false : "position"} className="ui-thinking__labels">
        <AnimatePresence initial={false}>
          <motion.span
            key={label}
            className="ui-thinking__label"
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: reduced ? { duration: 0 } : LABEL_IN }}
            exit={{ opacity: 0, y: reduced ? 0 : -4, transition: reduced ? { duration: 0 } : LABEL_OUT }}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </motion.span>
      {detail ? (
        <motion.span layout={reduced ? false : "position"} aria-hidden className="ui-thinking__detail">
          {detail}
        </motion.span>
      ) : null}
    </motion.div>
  );
}
