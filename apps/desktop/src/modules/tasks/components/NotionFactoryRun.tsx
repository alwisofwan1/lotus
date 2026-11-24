"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { FactoryRun } from "@/modules/tasks/components/FactoryRunSection";
import { keepNotionRepo, keptNotionRepo, type FactoryRef, type FactoryRunClient } from "@/modules/factory";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";

/** Running a Notion ticket as a Factory Run (#168). The code is not in Notion, so a repo is picked here. */
export interface NotionTicketFactory {
  client: FactoryRunClient;
  /** The Notion source: the repo picked is remembered per database, as New run does. */
  sourceId: string;
  /** The GitHub sources: where the code is, and the gh account the run uses. */
  repos: readonly { id: string; repo: string; account: string }[];
  workspaces: () => { id: string; cwd: string; remote: boolean }[];
  /** The page and properties as they are when the run starts. Read only. */
  readBody: () => Promise<string | null>;
  /** Opens the Factory on the run; `"chief"` opens the Chief of Staff on its PR (CoS 10). */
  onOpenRun?: (repo: string, issue: FactoryRef, tab?: "chief") => void;
}

/** The Factory card of a Notion ticket: the repo its code is in, then the run in that repo. */
export function NotionFactoryRun({
  factory,
  ticket,
  presets,
}: {
  factory: NotionTicketFactory;
  ticket: { key: string; title: string; pageId: string; url: string };
  presets: readonly DelegationPreset[];
}) {
  const [repoId, setRepoId] = useState<string | null>(() => {
    const kept = keptNotionRepo(factory.sourceId);
    return factory.repos.some((r) => r.id === kept) ? kept : (factory.repos[0]?.id ?? null);
  });
  const repo = factory.repos.find((r) => r.id === repoId) ?? null;
  if (!repo) {
    return (
      <>
        <h3 className="tk-props-h">Factory</h3>
        <p className="tk-props-note">Add a GitHub ticket source for the repo of this ticket. Then the Factory can build it.</p>
      </>
    );
  }
  const pick = (id: string) => {
    keepNotionRepo(factory.sourceId, id);
    setRepoId(id);
  };
  const picker =
    factory.repos.length > 1 ? (
        <label className="tk-select-chip tk-select-chip--block tk-factory-repo">
          <span className="tk-select-chip-value">code in {repo.repo}</span>
          <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
          <select value={repo.id} aria-label="Repo for this ticket's code" onChange={(event) => pick(event.target.value)}>
            {factory.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.repo}
              </option>
            ))}
          </select>
        </label>
    ) : (
      <p className="tk-props-note">Code in {repo.repo}</p>
    );
  return (
    <FactoryRun
        // One run per repo: a new repo reads its own run.
        key={repo.id}
        client={factory.client}
        repo={repo.repo}
        account={repo.account}
        workspaces={factory.workspaces}
        issue={{ number: ticket.key, title: ticket.title, body: null }}
        notion={{ pageId: ticket.pageId, url: ticket.url }}
        readBody={factory.readBody}
        presets={presets}
        picker={picker}
        onOpenInFactory={factory.onOpenRun ? () => factory.onOpenRun!(repo.repo, ticket.key) : undefined}
        onOpenInChief={factory.onOpenRun ? () => factory.onOpenRun!(repo.repo, ticket.key, "chief") : undefined}
      />
  );
}
