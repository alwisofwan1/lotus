"use client";

import { ChevronRight, GitBranch, Layers, Plug, ShieldCheck, Sparkles } from "lucide-react";
import type { FactoryCatalog, FactoryDefinition, FactoryDefinitionView, FactoryRole } from "@/lib/tauri/graph-run";
import type { FactoryStageStatus } from "../services/factory-progress";
import { DitherPixels } from "./FactoryDither";
import { ROLES, isUnpushed, kitMissing, modelLabel, roleKit } from "../services/factory-agents";

export type PipelineOpened = FactoryRole | "every";

const SHARED_TAGS = 3;

/** A row's state as a dither texture: the stage strip's own grammar, so one look means one thing. */
const ROLE_TILE: Record<"ready" | "attention" | "later", FactoryStageStatus> = { ready: "done", attention: "needs-you", later: "todo" };

/**
 * The default Settings view (round 6): the five roles as a rail, top to bottom in the order a ticket
 * moves, then what every role shares and the checks a run must pass. A row is a summary of what the
 * saved definition gives the run; the editor beside it holds the draft. Each row's dither tile is its
 * state, so it reads without colour: grain = ready, hatch = needs attention, dots = not run yet.
 */
export function FactoryPipeline({
  view,
  definition,
  presets,
  catalog,
  opened,
  onOpen,
  onOpenChecks,
}: {
  view: FactoryDefinitionView;
  definition: FactoryDefinition;
  presets: { id: string; name: string }[];
  catalog: FactoryCatalog | null;
  opened: PipelineOpened | null;
  onOpen: (opened: PipelineOpened) => void;
  onOpenChecks: () => void;
}) {
  const shared = [...definition.skills.map((name) => ({ kind: "skill" as const, name })), ...definition.mcp.map((name) => ({ kind: "mcp" as const, name }))];
  const cap = definition.capUsd !== null ? ` · cap $${definition.capUsd.toFixed(2)} per run` : "";
  return (
    <div className="fa-pipeline">
      <header className="fa-pipeline-intro">
        <h2>How a ticket becomes a draft PR</h2>
        <p>Five agents, in order, each in its own copy of the repo. Select one to tune it.</p>
      </header>
      <ol className="fa-pipeline-steps" aria-label="Roles in run order">
        {ROLES.map((info, index) => {
          const agent = definition.agents.find((a) => a.role === info.role)!;
          // What the run gets (Every agent + the role's own), not only the role's file. A role no run
          // prepares yet keeps counting its own file: its row already says "Coming soon".
          const kit = roleKit(info.role, definition, agent, catalog);
          const skills = info.usedFrom ? agent.skills.length : kit.skills.length;
          const servers = info.usedFrom ? agent.mcp.length : kit.mcp.length;
          const missing = info.usedFrom ? 0 : kitMissing(kit);
          const full = agent.access === "full";
          const state = info.usedFrom ? "later" : missing > 0 ? "attention" : "ready";
          return (
            <li key={info.role} className="fa-pipeline-item">
              <button
                type="button"
                className="fa-role-card"
                data-open={opened === info.role ? "true" : undefined}
                data-later={info.usedFrom ? "true" : undefined}
                data-full={full ? "true" : undefined}
                disabled={Boolean(info.usedFrom)}
                onClick={() => onOpen(info.role)}
              >
                <span className="fa-role-tile" data-state={state} aria-hidden>
                  <DitherPixels status={ROLE_TILE[state]} pixel={4} />
                </span>
                <span className="fa-role-main">
                  <span className="fa-role-top">
                    <span className="fa-agent-step" aria-hidden>
                      {index + 1}
                    </span>
                    <span className="fa-role-name">{info.role}</span>
                    <span className="fa-role-status" data-state={state}>
                      {info.usedFrom ? (
                        "Coming soon"
                      ) : isUnpushed(view, info.role) ? (
                        <span className="fa-unpushed">not pushed</span>
                      ) : missing > 0 ? (
                        "Needs attention"
                      ) : (
                        "Ready"
                      )}
                    </span>
                  </span>
                  <span className="fa-role-does">{info.does}</span>
                  <span className="fa-role-chips">
                    <span className="fa-role-model" data-default={agent.preset ? undefined : "true"}>
                      {modelLabel(agent, presets)}
                    </span>
                    <span className="fa-chip" data-bad={missing > 0 ? "true" : undefined}>
                      {skills} skill{skills === 1 ? "" : "s"}
                      {missing > 0 ? ` · ${missing} missing` : ""}
                    </span>
                    {info.role === "triage" ? (
                      <span className="fa-chip" data-muted="true">
                        no MCP
                      </span>
                    ) : (
                      <span className="fa-chip">{servers} MCP</span>
                    )}
                    <span className="fa-chip" data-full={full ? "true" : undefined}>
                      {full ? "Full access" : "Read-only"}
                    </span>
                  </span>
                </span>
                <ChevronRight className="fa-role-go" size={14} aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="fa-pipeline-summary">
        <button type="button" className="fa-summary-card fa-summary-card--shared" data-open={opened === "every" ? "true" : undefined} onClick={() => onOpen("every")}>
          <span className="fa-summary-icon" aria-hidden>
            <Layers size={13} />
          </span>
          <span className="fa-summary-main">
            <span className="fa-summary-head">
              <span className="fa-summary-title">Shared by all roles</span>
              {isUnpushed(view, null) ? <span className="fa-unpushed">not pushed</span> : null}
            </span>
            <span className="fa-summary-text">Every role gets these first. Triage never gets MCP servers{cap}.</span>
            <span className="fa-summary-tags">
              {shared.length === 0 ? <span className="fa-summary-text">Nothing shared yet.</span> : null}
              {shared.slice(0, SHARED_TAGS + 2).map((item) => (
                <span key={`${item.kind}:${item.name}`} className="fa-chip">
                  {item.kind === "skill" ? <Sparkles size={11} aria-hidden /> : <Plug size={11} aria-hidden />}
                  {item.name}
                </span>
              ))}
              {shared.length > SHARED_TAGS + 2 ? <span className="fa-chip" data-muted="true">+{shared.length - SHARED_TAGS - 2} more</span> : null}
            </span>
          </span>
          <ChevronRight className="fa-role-go" size={14} aria-hidden />
        </button>
        <section className="fa-summary-card" aria-label="Checks summary">
          <span className="fa-summary-icon" aria-hidden>
            <ShieldCheck size={13} />
          </span>
          <span className="fa-summary-main">
            <span className="fa-summary-head">
              <span className="fa-summary-title">Checks before a draft PR</span>
              <button type="button" className="fa-link" onClick={onOpenChecks}>
                Open Checks →
              </button>
            </span>
            <code className="fa-summary-command">{definition.gate}</code>
            <span className="fa-summary-text">A run must pass this before a draft PR opens.</span>
          </span>
        </section>
      </div>
      {view.unpushed.length > 0 ? (
        <p className="fa-push-note">
          <GitBranch size={14} aria-hidden />
          Save writes to the repo folder. A run reads origin/{view.base ?? "<base>"}, so it uses your changes only after you
          commit and push them.
        </p>
      ) : null}
    </div>
  );
}
