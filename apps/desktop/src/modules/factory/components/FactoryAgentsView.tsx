"use client";

import { Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, ResourceTabs, SkeletonRows } from "@/components/resource/resource-kit";
import type { FactoryCatalog, FactoryDefinitionView } from "@/lib/tauri/graph-run";
import { FACTORY_FILE, isUnpushed, unpushedLine, type FactoryAgentsSource } from "../services/factory-agents";
import { prsGoInto } from "../services/factory-new-run";
import { FactorySplit, useEscape } from "./FactorySplit";
import { FactoryRepoSelect } from "./FactoryRepoSelect";
import { FactoryAgentPane, FactorySharedPane } from "./FactoryAgentPane";
import { EmptyDither } from "./FactoryDither";
import { FactoryConfiguration } from "./FactoryConfiguration";
import { FactoryIntegrations } from "./FactoryIntegrations";
import { FactoryPipeline, type PipelineOpened } from "./FactoryPipeline";
import { useFactoryCatalog } from "../hooks/useFactoryCatalog";
import "@/styles/factory.css";

type Loaded =
  | { kind: "loading" }
  | { kind: "no-repo" }
  | { kind: "no-checkout"; repo: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; checkout: string; view: FactoryDefinitionView; repo: string };

type Opened = PipelineOpened;
type Section = "pipeline" | "checks" | "integrations";

const REPO_KEY = "factory-agents-repo";

const readRepo = (): string | null => {
  try {
    return window.localStorage.getItem(REPO_KEY);
  } catch {
    return null;
  }
};
const keepRepo = (id: string) => {
  try {
    window.localStorage.setItem(REPO_KEY, id);
  } catch {
    /* the last repo is a convenience */
  }
};

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The Agents tab (FI5): one repo's factory, as its checkout holds it. Each row is a role; opening
 * one edits it beside the list. Saving writes the checkout only, so the bar says when files are
 * not pushed: a run reads `origin/<base>`.
 */
export function FactoryAgentsView({ source }: { source: FactoryAgentsSource }) {
  const [repoId, setRepoId] = useState<string | null>(() => {
    const kept = readRepo();
    return source.repos.some((r) => r.id === kept) ? kept : (source.repos[0]?.id ?? null);
  });
  const repo = source.repos.find((r) => r.id === repoId) ?? null;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([]);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [chosen, setChosen] = useState<Section | null>(null);
  // Bumped after each save, so the view (and which files are not pushed) is read again.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    source
      .presets()
      .then((list) => live && setPresets(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [source]);

  useEffect(() => {
    let live = true;
    const load = async (): Promise<Loaded> => {
      if (!repo) return { kind: "no-repo" };
      const checkout = await source.findCheckout(repo.repo);
      if (!checkout) return { kind: "no-checkout", repo: repo.repo };
      const view = await source.view(checkout, repo.repo);
      return { kind: "ready", checkout, view, repo: repo.repo };
    };
    load()
      .then((next) => live && setLoaded(next))
      .catch((cause) => live && setLoaded({ kind: "error", message: messageOf(cause) }));
    return () => {
      live = false;
    };
  }, [repo, source, generation]);

  useEscape(opened !== null, () => setOpened(null));

  const pickRepo = (id: string) => {
    keepRepo(id);
    setRepoId(id);
    setOpened(null);
    setLoaded({ kind: "loading" });
  };

  const ready = loaded.kind === "ready" ? loaded : null;
  const { state: integrations, rescan } = useFactoryCatalog(source, ready?.checkout ?? null, ready?.view.base ?? null, ready?.repo ?? null, generation);
  const catalog = integrations.catalog;
  // Saves go where the view reads: the checkout, or Lotus's private factory for the repo (#169).
  const target = ready ? (ready.view.private?.dir ?? ready.checkout) : null;
  const definition = ready?.view.local.definition ?? null;
  const unpushed = ready ? unpushedLine(ready.view) : null;
  // Without a definition the only useful view is Checks, where the setup lives.
  const section: Section = chosen ?? (definition ? "pipeline" : "checks");
  const warnings = integrations.kind === "ready" ? integrations.catalog.notes.length : 0;
  const saved = () => setGeneration((n) => n + 1);
  const agentsBody = (
    <PipelineBody
      loaded={loaded}
      presets={presets}
      opened={opened}
      catalog={catalog}
      onOpen={setOpened}
      onOpenChecks={() => setChosen("checks")}
      setupAvailable={Boolean(ready?.view.private)}
    />
  );

  return (
    <div className="fa-agents">
      {/* One sub-row (round 6): the three views, then what a saver needs to know, then the repo. */}
      <div className="fa-agents-bar">
        {ready ? (
          <ResourceTabs
            label="Settings views"
            value={section}
            onChange={setChosen}
            tabs={[
              { id: "pipeline", label: "Pipeline" },
              { id: "checks", label: "Checks" },
              { id: "integrations", label: "Integrations", count: warnings, tone: "attention" },
            ]}
          />
        ) : null}
        <span className="fa-agents-gap" />
        {unpushed ? (
          <span className="fa-unpushed-pill" title={ready?.view.unpushed.map((f) => `${f.path} (${f.state})`).join("\n")}>
            {unpushed}
          </span>
        ) : null}
        {ready?.view.base && (!ready.view.private || definition) ? (
          <span className="fa-agents-base" title={prsGoInto({ name: ready.view.base, fromFile: ready.view.baseFromFile })}>
            PRs → {ready.view.base}
          </span>
        ) : null}
        {ready?.view.private && definition ? (
          <span className="fa-agents-private" title={`Private to this Mac · not in the repo\n${ready.view.private.dir}`}>
            <Laptop size={12} aria-hidden />
            Saved on this Mac only
          </span>
        ) : null}
        <span className="fa-agents-repo" title={ready?.checkout}>
          <FactoryRepoSelect
            label="Repo"
            value={repoId ?? ""}
            options={source.repos.map((r) => ({ value: r.id, label: r.repo }))}
            onChange={pickRepo}
            disabled={source.repos.length === 0}
          />
        </span>
      </div>
      <FactorySplit tab="agents" open={Boolean(opened && definition)} label="Resize agent settings">
        <div className="rs-scroll">
          <div className="rs-band fa-agents-band">
            {ready ? (
              <div hidden={section !== "checks"}>
                <FactoryConfiguration key={ready.repo} source={source} checkout={ready.checkout} repo={ready.repo} view={ready.view} onChanged={saved} />
              </div>
            ) : null}
            {section === "pipeline" || !ready || (!definition && section === "checks") ? agentsBody : null}
            {ready && section === "integrations" ? <FactoryIntegrations state={integrations} onRefresh={rescan} /> : null}
          </div>
        </div>
        {ready && definition && opened ? (
          <aside className="rs-scroll fa-detail-pane" aria-label="Agent settings">
            {opened === "every" ? (
              <FactorySharedPane
                key={`every:${generation}`}
                definition={definition}
                catalog={catalog}
                unpushed={isUnpushed(ready.view, null)}
                privateFactory={Boolean(ready.view.private)}
                onSave={async (skills, mcp) => {
                  await source.saveShared(target!, skills, mcp);
                  saved();
                }}
                onClose={() => setOpened(null)}
              />
            ) : (
              <FactoryAgentPane
                key={`${opened}:${generation}`}
                agent={definition.agents.find((a) => a.role === opened)!}
                shared={definition}
                builtInPrompt={ready.view.builtInPrompts[opened]}
                catalog={catalog}
                presets={presets}
                unpushed={isUnpushed(ready.view, opened)}
                privateFactory={Boolean(ready.view.private)}
                onSave={async (edit) => {
                  await source.saveAgent(target!, opened, edit);
                  saved();
                }}
                onClose={() => setOpened(null)}
              />
            )}
          </aside>
        ) : null}
      </FactorySplit>
    </div>
  );
}

function PipelineBody({
  loaded,
  presets,
  opened,
  catalog,
  onOpen,
  onOpenChecks,
  setupAvailable,
}: {
  loaded: Loaded;
  presets: { id: string; name: string }[];
  opened: Opened | null;
  catalog: FactoryCatalog | null;
  onOpen: (opened: Opened) => void;
  onOpenChecks: () => void;
  setupAvailable: boolean;
}) {
  switch (loaded.kind) {
    case "loading":
      return <SkeletonRows label="Loading the factory" />;
    case "no-repo":
      return <EmptyState art={<EmptyDither />}>Add a GitHub ticket source in Tasks to set up a factory.</EmptyState>;
    case "no-checkout":
      return <EmptyState art={<EmptyDither />}>No open workspace holds a checkout of {loaded.repo}. Open it in the sidebar first.</EmptyState>;
    case "error":
      return (
        <p role="alert" className="fa-agents-alert">
          Could not read the factory: {loaded.message}
        </p>
      );
  }
  const { view } = loaded;
  const definition = view.local.definition;
  return (
    <div className="fa-agents-list">
      {view.notes.map((note) => (
        <p key={note} className="fa-agents-note">
          Showing the last fetched origin: {note}
        </p>
      ))}
      {!definition && setupAvailable && view.local.error?.startsWith(`no ${FACTORY_FILE}`) ? null : !definition ? (
        <NoDefinition error={view.local.error} />
      ) : (
        <>
          <FactoryPipeline view={view} definition={definition} presets={presets} catalog={catalog} opened={opened} onOpen={onOpen} onOpenChecks={onOpenChecks} />
          {view.origin.error && !view.origin.error.includes("gate") ? (
            <p className="fa-agents-note">Runs cannot read origin&apos;s factory: {view.origin.error}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function NoDefinition({ error }: { error: string | null }) {
  if (error?.startsWith(`no ${FACTORY_FILE}`)) {
    return (
      <EmptyState art={<EmptyDither />}>
        This repo has no factory yet. Add <code>{FACTORY_FILE}</code> with <code>gate = &quot;…&quot;</code> (the command that
        must pass), then open this tab again.
      </EmptyState>
    );
  }
  return (
    <p role="alert" className="fa-agents-alert">
      The factory files in this checkout do not parse: {error}. Fix the file, then open this tab again.
    </p>
  );
}
