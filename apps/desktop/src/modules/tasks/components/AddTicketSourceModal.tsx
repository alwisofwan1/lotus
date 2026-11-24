"use client";

import { useId } from "react";
import { BookOpen, CircleDot } from "lucide-react";
import { TasksModal } from "@/modules/tasks/components/TasksModal";
import { TicketSourceMark } from "@/modules/tasks/components/TicketSourceMark";

/**
 * Add a ticket source: pick a kind (`SOURCES 02`).
 *
 * Every kind is listed, including the ones that cannot be added yet, so a person looking for one
 * finds it here and learns it is coming rather than concluding it does not exist. Obsidian and
 * Notion can be added; Notion needs its account connected in Connectors first (PLAN S16). GitHub
 * needs a `gh` login; without one its row opens Connectors, where the login command is.
 */

export interface AddTicketSourceModalProps {
  /** v1 holds one vault (`plans/ticket-sources/PLAN.md` S8), so a second is not offered. */
  hasObsidian: boolean;
  onPickObsidian: () => void;
  /** A Notion account is connected in Connectors. Without one, Notion says where to connect it. */
  notionConnected: boolean;
  onPickNotion: () => void;
  /** How many `gh` logins there are; null while they are read. */
  githubAccounts: number | null;
  onPickGitHub: () => void;
  /** Opens Connectors — where a missing gh login is added. */
  onOpenConnectors?: () => void;
  onClose: () => void;
}

interface Kind {
  id: string;
  name: string;
  description: string;
  mark: React.ReactNode;
  /** Why it cannot be picked, shown where the arrow would be. Absent = it can be picked. */
  unavailable?: string;
  onPick?: () => void;
}

export function AddTicketSourceModal({
  hasObsidian,
  onPickObsidian,
  notionConnected,
  onPickNotion,
  githubAccounts,
  onPickGitHub,
  onOpenConnectors,
  onClose,
}: AddTicketSourceModalProps) {
  const headingId = useId();

  const kinds: Kind[] = [
    {
      id: "obsidian",
      name: "Obsidian vault",
      description: "A folder of markdown tickets on this Mac. Read and edited in place; Obsidian and git keep working.",
      mark: <TicketSourceMark kind="obsidian" size={16} />,
      unavailable: hasObsidian ? "Added" : undefined,
      onPick: hasObsidian ? undefined : onPickObsidian,
    },
    {
      id: "notion",
      name: "Notion database",
      description: "A team board in Notion. Lotus lists, opens and delegates its tickets, and can manage them where you allow it.",
      mark: <TicketSourceMark kind="notion" size={16} />,
      unavailable: notionConnected ? undefined : "Connect in Connectors first",
      onPick: notionConnected ? onPickNotion : undefined,
    },
    {
      id: "github",
      name: "GitHub Issues",
      description: "The issues of a repository you choose, read through gh. Read only.",
      mark: <TicketSourceMark kind="github" size={16} />,
      ...(githubAccounts === null
        ? { unavailable: "Reading gh…" }
        : githubAccounts > 0
          ? { onPick: onPickGitHub }
          : { unavailable: "Log in with gh — open Connectors", onPick: onOpenConnectors }),
    },
    {
      id: "linear",
      name: "Linear",
      description: "A team’s issues.",
      mark: (
        <span className="tk-vault-mark" aria-hidden>
          <CircleDot size={16} strokeWidth={1.75} />
        </span>
      ),
      unavailable: "Later",
    },
  ];

  return (
    <TasksModal labelledBy={headingId} onClose={onClose} className="tk-add-source">
      <div className="tk-add-source-body">
        <h2 className="tk-add-source-title" id={headingId}>
          <BookOpen size={15} strokeWidth={1.75} aria-hidden />
          Add a ticket source
        </h2>

        <ul className="tk-add-source-kinds">
          {kinds.map((kind, index) => (
            <li key={kind.id}>
              <button
                type="button"
                className="tk-add-source-kind"
                disabled={!kind.onPick}
                onClick={kind.onPick}
                // The first kind that can be picked takes focus, so Enter adds it.
                autoFocus={Boolean(kind.onPick) && kinds.findIndex((k) => k.onPick) === index}
              >
                {kind.mark}
                <span className="tk-add-source-text">
                  <span className="tk-add-source-name">{kind.name}</span>
                  <span className="tk-add-source-description">{kind.description}</span>
                </span>
                {kind.unavailable ? <span className="tk-add-source-badge">{kind.unavailable}</span> : null}
              </button>
            </li>
          ))}
        </ul>

        <p className="tk-add-source-note">Sources are independent. Lotus tasks work with none connected.</p>
      </div>
    </TasksModal>
  );
}
