"use client";
import { ArrowRight, ArrowUpRight, ChevronDown, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { openExternalLink } from "@/lib/tauri-api";
import { BrandMark } from "@/components/icons/BrandMark";
import { Button } from "@/components/ui/button";
import { IconTile, Status } from "@/components/ui/status";
import { SettingRow, SettingsGroup } from "../components/SettingsGroup";
import { useEffect, useState } from "react";
import { checkAppUpdate, installAppUpdate, useAppUpdate } from "../services/app-update";

/** The Lotus app's own update block, rendered in Settings › About. CLI updates live in AgentClisSection. */
export function LotusAppUpdate() {
  const { enabled, phase, version, notes, date, progress, error } = useAppUpdate();
  const [current, setCurrent] = useState<string | null>(null);
  // null = follow the phase: open once the update is ready, closed while it downloads.
  const [notesOpen, setNotesOpen] = useState<boolean | null>(null);
  const offered = Boolean(version && notes && (phase === "downloading" || phase === "ready" || phase === "installing"));
  const showNotes = offered && (notesOpen ?? (phase === "ready" || phase === "installing"));
  useEffect(() => {
    void import("@tauri-apps/api/app").then((m) => m.getVersion()).then(setCurrent, () => undefined);
  }, []);

  const meta = !enabled
    ? null
    : phase === "checking"
      ? "Checking for a new version…"
      : phase === "downloading"
        ? `Downloading ${version}${progress !== null ? ` · ${Math.round(progress * 100)}%` : ""}`
        : phase === "ready" || phase === "installing"
          ? `${version} is ready. Lotus restarts to finish.`
          : phase === "error"
            ? "Could not check for a new version"
            : "Up to date";

  return (
    <SettingsGroup title="Updates" footer={phase === "error" && error ? error : undefined}>
      <SettingRow
        leading={<IconTile><BrandMark className="ui-update-mark size-[18px] object-contain" /></IconTile>}
        label="Lotus app"
        monoDescription
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5 tabular-nums" aria-live="polite">
            <span>{current ?? "…"}</span>
            {version && phase !== "idle" && phase !== "error" ? (
              <>
                <ArrowRight size={11} aria-label="to" />
                <span className="text-(--ui-ink)">{version}</span>
              </>
            ) : null}
            {meta ? <span className="font-sans">· {meta}</span> : null}
            {offered ? (
              <button
                type="button"
                className="ui-update-toggle font-sans"
                aria-expanded={showNotes}
                onClick={() => setNotesOpen(!showNotes)}
              >
                What&apos;s new
                <ChevronDown size={11} aria-hidden />
              </button>
            ) : null}
          </span>
        }
        body={showNotes && version && notes ? <ReleaseNotes version={version} notes={notes} date={date} /> : undefined}
      >
        {phase === "ready" || phase === "installing" ? (
          <Button variant="primary" size="sm" disabled={phase === "installing"} onClick={() => void installAppUpdate()}>
            <RotateCcw size={13} className={phase === "installing" ? "animate-spin" : undefined} />
            Restart to update
          </Button>
        ) : phase === "checking" || phase === "downloading" ? (
          <Status busy>{phase === "checking" ? "Checking" : "Downloading"}</Status>
        ) : (
          <Button
            size="sm"
            disabled={!enabled}
            onClick={() => void checkAppUpdate()}
            aria-label="Check for a new Lotus version"
            title={enabled ? "Check again" : "Self-update runs in release builds only"}
          >
            <RotateCcw size={13} />
            Check for updates
          </Button>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}

/** Feed `pub_date` looks like "2026-11-19 10:00:00.0 +00:00:00" — not something Date parses; the day is enough. */
function releaseDay(date: string | null): string | null {
  const day = date?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return day ? new Date(`${day}T00:00:00`).toLocaleDateString("en-US", { dateStyle: "long" }) : null;
}

function ReleaseNotes({ version, notes, date }: { version: string; notes: string; date: string | null }) {
  // Feeds before 0.14.1 carry only the title, so the body may be empty.
  const cut = notes.indexOf("\n\n");
  const title = cut < 0 ? notes : notes.slice(0, cut);
  const body = cut < 0 ? "" : notes.slice(cut + 2).trim();
  const day = releaseDay(date);
  return (
    <div className="ui-update-notes">
      <h4 className="ui-update-notes-title">{title}</h4>
      <div className="ui-update-notes-sub">
        Lotus {version}
        {day ? ` · ${day}` : null}
      </div>
      {body ? (
        <div className="ui-update-notes-body" tabIndex={0} aria-label="Release notes">
          <ReactMarkdown>{body}</ReactMarkdown>
        </div>
      ) : null}
      <div className="ui-update-notes-foot">
        <button type="button" onClick={() => void openExternalLink(`https://lotus-web.pages.dev/changelog/#v${version}`)}>
          Full changelog
          <ArrowUpRight size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
}
