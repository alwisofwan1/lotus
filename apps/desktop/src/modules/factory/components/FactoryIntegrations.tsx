"use client";

import { ChevronDown, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { FactoryCatalog } from "@/lib/tauri/graph-run";
import { SkeletonRows } from "@/components/resource/resource-kit";
import { summarizeNote } from "../services/factory-agents";

type State =
  | { kind: "loading"; catalog: null }
  | { kind: "ready"; catalog: FactoryCatalog }
  | { kind: "error"; catalog: null; message: string };

/**
 * What this Mac offers: how many skills and MCP servers were found, and the warnings that need a
 * decision, one row each with the first sentence; the runner's whole text opens under Details. Lotus
 * only reads Claude's configuration, so a row explains and never offers to change it. Discovery is not
 * a connectivity check, and the page says so.
 */
export function FactoryIntegrations({ state, onRefresh }: { state: State; onRefresh: () => void }) {
  return (
    <section className="fa-integrations" aria-label="Integrations" aria-busy={state.kind === "loading"}>
      <header className="fa-integrations-head">
        <div>
          <h2>What this Mac offers</h2>
          <p>Discovery does not verify server connectivity. Only selected skills and MCP servers are prepared for a run.</p>
        </div>
        <button type="button" className="rs-button" onClick={onRefresh} disabled={state.kind === "loading"}>
          Refresh integrations
        </button>
      </header>
      {state.kind === "loading" ? <SkeletonRows count={3} label="Loading integrations" /> : null}
      {state.kind === "error" ? (
        <p role="alert" className="fa-agents-alert">
          Could not load integrations: {state.message}
        </p>
      ) : null}
      {state.kind === "ready" ? <Ready catalog={state.catalog} /> : null}
    </section>
  );
}

function Ready({ catalog }: { catalog: FactoryCatalog }) {
  const notices = catalog.notices ?? [];
  const count = catalog.notes.length;
  return (
    <>
      <p role="status" className="fa-integrations-count">
        {catalog.skills.length} skills · {catalog.mcp.length} MCP servers discovered
      </p>
      {count > 0 ? (
        <div className="fa-warnings">
          <h3 className="fa-group-label" data-tone="warn">
            {count} {count === 1 ? "needs" : "need"} a decision
          </h3>
          <ul className="fa-warning-rows">
            {catalog.notes.map((note, i) => (
              <Warning key={i} note={note} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="fa-agents-note">Nothing needs a decision.</p>
      )}
      {notices.length > 0 ? (
        <details className="fa-integrations-info">
          <summary>Integration information ({notices.length})</summary>
          <ul>
            {notices.map((notice, i) => (
              <li key={i} className="fa-agents-note">
                {notice}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function Warning({ note }: { note: string }) {
  const { title, summary, detail } = summarizeNote(note);
  const [open, setOpen] = useState(false);
  return (
    <li className="fa-warning-row" data-open={open ? "true" : undefined}>
      <TriangleAlert size={15} aria-hidden />
      <div className="fa-warning-text">
        <code>{title}</code>
        <p>{summary}</p>
        {open ? <p className="fa-warning-detail">{detail}</p> : null}
      </div>
      <button type="button" className="rs-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide details" : "Details"}
        <ChevronDown size={12} aria-hidden />
      </button>
    </li>
  );
}
