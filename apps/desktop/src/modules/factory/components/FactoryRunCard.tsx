"use client";

import { ArrowRight, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { FactoryRunHandle } from "../hooks/useFactoryRun";
import { factoryCardPrLine } from "../services/factory-chief";
import { factoryRunDetail } from "../services/factory-run-detail";
import { factoryGroupOf } from "../services/factory-run-list";
import { FactoryStageBar } from "./FactoryStageBar";
import "@/styles/factory.css";

const REMEMBERED = "lotus.factory.implementer";

function readRemembered(): string | null {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(REMEMBERED, id);
  } catch {
    /* storage off: the pick lasts until the card closes */
  }
}

/**
 * One issue's Factory Run, small, for the issue panel. With a run it says where the run is in the
 * Factory's own words and colours, and its one action is to open it there — every other action
 * lives in the Factory. With none it offers to start one, as the implementer picked last time.
 * While the Chief of Staff watches the run's PR, the card says where the PR stands and opens the
 * Chief of Staff on it (CoS 10). Read only: nothing here writes to the ticket or adds a task.
 *
 * `presets` are already the ones that can run the implementer (Claude only).
 */
export function FactoryRunCard({
  run,
  presets,
  onOpenInFactory,
  onOpenInChief,
}: {
  run: FactoryRunHandle;
  presets: readonly { id: string; name: string }[];
  onOpenInFactory?: () => void;
  /** Opens the Factory's Chief of Staff with this run's PR selected (CoS 10). */
  onOpenInChief?: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(readRemembered);
  const preset = presets.find((p) => p.id === chosen) ?? presets[0] ?? null;
  const { view } = run;

  const choose = (id: string) => {
    setChosen(id);
    remember(id);
  };

  if (run.loading) {
    return (
      <section className="fa-card fa-issue-card" aria-label="Factory">
        <p className="fa-card-line">Reading…</p>
      </section>
    );
  }

  const error = run.error ? (
    <p className="fa-error" role="alert">
      {run.error}
    </p>
  ) : null;

  if (view.state === "idle") {
    return (
      <section className="fa-card fa-issue-card" aria-label="Factory">
        <p className="fa-issue-card-title">Let an agent fix this</p>
        <p className="fa-card-line">It works in its own worktree and opens a draft PR when the repo&apos;s check passes.</p>
        {presets.length > 1 ? (
          <label className="tk-select-chip tk-select-chip--block">
            <span className="tk-select-chip-value">as {preset?.name}</span>
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
            <select value={preset?.id ?? ""} aria-label="Implementer for the Factory Run" onChange={(event) => choose(event.target.value)}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : preset ? (
          <p className="fa-card-meta">as {preset.name}</p>
        ) : null}
        <button
          type="button"
          className="rs-button rs-button--primary fa-issue-card-action"
          disabled={!run.canStart || !preset}
          onClick={() => preset && void run.start(preset.id)}
        >
          {run.busy ? "Starting…" : "Run in Factory"}
        </button>
        {run.checkout === null ? (
          <p className="fa-card-meta">No open workspace holds a checkout of this repo. Open it in the sidebar first.</p>
        ) : !preset ? (
          <p className="fa-card-meta">Make a Claude preset first (Delegate → New preset).</p>
        ) : null}
        {error}
      </section>
    );
  }

  const group = factoryGroupOf(view.state);
  const detail = factoryRunDetail(view);
  const prLine = factoryCardPrLine(view);
  return (
    <section className="fa-card fa-issue-card" aria-label="Factory" data-group={group}>
      <p className="fa-issue-card-title">
        <span className="fa-glyph" data-group={group} aria-hidden />
        <span className="fa-status" data-group={group}>
          {detail.statusWord}
        </span>
      </p>
      <FactoryStageBar progress={view.progress} state={view.state} />
      <p className="fa-card-line">{detail.sentence}</p>
      {prLine ? <p className="fa-card-meta fa-issue-card-pr">{prLine}</p> : null}
      {prLine && onOpenInChief ? (
        <button type="button" className="rs-button fa-issue-card-action" onClick={onOpenInChief}>
          Open in Chief of Staff
          <ArrowRight size={13} strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
      {onOpenInFactory ? (
        <button type="button" className="rs-button fa-issue-card-action" onClick={onOpenInFactory}>
          Open in Factory
          <ArrowRight size={13} strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
      {error}
    </section>
  );
}
