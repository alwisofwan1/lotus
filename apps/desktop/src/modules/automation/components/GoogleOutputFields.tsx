"use client";

import { ExternalLink, FileText, Table, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Pill } from "@/components/resource/resource-kit";

import type {
  GoogleAccountState,
  GoogleDriveFormat,
  GoogleDriveOutput,
  GooglePicked,
  GoogleSheetOutput,
} from "../services/automation-api";

/**
 * A scheduled prompt's Google outputs, in the form's "Deliver to" (plans/google-connector G15–G18,
 * mockup GOOGLE 04). A new sheet is made when the automation is saved — named after it, the
 * columns as its header — because with `drive.file` Lotus can only write files it made or the
 * user picked. An existing sheet or folder is chosen in Google's Picker (slice 05), which is what
 * grants Lotus access to it; a link to one Lotus made before can also be pasted.
 */

/** Opens the Picker; resolves with the choice, rejects when cancelled or failed. */
export type GooglePicker = { pick(kind: "sheet" | "folder"): Promise<GooglePicked>; cancel(): Promise<void> };

/** What the form keeps while it is open. */
export type GoogleOutputsState = {
  sheetOn: boolean;
  /** The chosen sheet's id; empty: make a new one on save. */
  sheetId: string;
  sheetUrl: string | null;
  /** The picked sheet's name, when it came from the Picker. */
  sheetName?: string | null;
  /** The picked sheet's tabs, offered instead of a free tab name. */
  sheetTabs?: string[];
  tab: string;
  columns: string[];
  driveOn: boolean;
  /** Empty: the top of My Drive. */
  folder: string;
  /** The picked folder's name, when it came from the Picker. */
  folderName?: string | null;
  format: GoogleDriveFormat;
};

export function initialGoogleOutputs(sheet?: GoogleSheetOutput | null, drive?: GoogleDriveOutput | null): GoogleOutputsState {
  return {
    sheetOn: Boolean(sheet),
    sheetId: sheet?.spreadsheetId ?? "",
    sheetUrl: sheet?.url ?? null,
    tab: sheet?.tab ?? "Daily",
    columns: sheet?.columns ?? ["Date", "Item", "Status", "Note"],
    driveOn: Boolean(drive),
    folder: drive && drive.folderId !== "root" ? drive.folderId : "",
    format: drive?.format ?? "google_doc",
  };
}

/** The id inside a Google link (`/spreadsheets/d/<id>`, `/folders/<id>`), or the text as an id. */
export function googleId(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/\/(?:spreadsheets\/d|folders|document\/d|file\/d)\/([\w-]+)/);
  return match ? match[1] : trimmed;
}

/** The form's `googleSheet` / `googleDrive`, as the engine takes them. */
export function googleForm(g: GoogleOutputsState): { googleSheet: GoogleSheetOutput | null; googleDrive: GoogleDriveOutput | null } {
  return {
    googleSheet: g.sheetOn ? { spreadsheetId: g.sheetId.trim() || "new", tab: g.tab, columns: g.columns } : null,
    googleDrive: g.driveOn ? { folderId: g.folder.trim() ? googleId(g.folder) : "root", format: g.format } : null,
  };
}

const FORMATS: { key: GoogleDriveFormat; label: string }[] = [
  { key: "google_doc", label: "Google Doc" },
  { key: "markdown", label: "Markdown" },
  { key: "csv", label: "CSV" },
];

export function GoogleOutputFields({
  google,
  value,
  onChange,
  fileStem,
  picker,
}: {
  google: GoogleAccountState | null;
  value: GoogleOutputsState;
  onChange: (next: GoogleOutputsState) => void;
  /** The automation's name, for the next file's name. */
  fileStem: string;
  /** Google's Picker; absent: only a new sheet or a pasted link. */
  picker?: GooglePicker;
}) {
  const connected = google?.state === "connected";
  const set = (patch: Partial<GoogleOutputsState>) => onChange({ ...value, ...patch });
  const [column, setColumn] = useState("");
  const [pasting, setPasting] = useState(false);
  const [picking, setPicking] = useState<"sheet" | "folder" | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const pick = async (kind: "sheet" | "folder") => {
    if (!picker) return;
    setPicking(kind);
    setPickError(null);
    try {
      const chosen = await picker.pick(kind);
      if (kind === "sheet")
        set({
          sheetId: chosen.id,
          sheetUrl: chosen.url,
          sheetName: chosen.name,
          sheetTabs: chosen.tabs ?? [],
          tab: chosen.tabs?.[0] ?? value.tab,
          columns: chosen.columns?.length ? chosen.columns : value.columns,
        });
      else set({ folder: chosen.id, folderName: chosen.name });
      setPasting(false);
    } catch (e) {
      const message = String(e);
      if (!message.includes("cancelled")) setPickError(message);
    } finally {
      setPicking(null);
    }
  };
  const waiting = (kind: "sheet" | "folder") =>
    picking === kind ? (
      <span className="au-gline" role="status">
        <span className="au-note">Choose it in the browser tab Lotus opened…</span>
        <button type="button" className="rs-button rs-button--ghost" onClick={() => void picker?.cancel()}>
          Cancel
        </button>
      </span>
    ) : null;

  const addColumn = () => {
    const name = column.trim().replace(/,$/, "").trim();
    if (!name || value.columns.some((c) => c.toLowerCase() === name.toLowerCase())) return setColumn("");
    set({ columns: [...value.columns, name] });
    setColumn("");
  };
  const columnKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addColumn();
    } else if (event.key === "Backspace" && !column && value.columns.length > 0) {
      set({ columns: value.columns.slice(0, -1) });
    }
  };
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
  const stem = `${fileStem.trim() || "This automation"} — ${when}`;
  const csvNeedsSheet = !value.sheetOn;

  return (
    <>
      <div className="au-gblock" data-on={value.sheetOn || undefined}>
        <label className="au-check">
          <input
            type="checkbox"
            checked={value.sheetOn}
            disabled={!connected && !value.sheetOn}
            onChange={(e) => set({ sheetOn: e.target.checked, format: !e.target.checked && value.format === "csv" ? "google_doc" : value.format })}
          />
          <Table size={14} strokeWidth={1.75} aria-hidden />
          Add rows to a Google Sheet
          {connected ? null : <span className="au-note">(connect Google in Connectors first)</span>}
        </label>
        {value.sheetOn ? (
          <div className="au-gblock-body">
            <div className="au-field">
              <span className="au-label">Sheet</span>
              {value.sheetId && !pasting ? (
                <span className="au-gline">
                  {value.sheetUrl ? (
                    <a href={value.sheetUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={12} aria-hidden /> {value.sheetName ? `Open “${value.sheetName}”` : "Open the sheet"}
                    </a>
                  ) : (
                    <code>{value.sheetId}</code>
                  )}
                  <button
                    type="button"
                    className="rs-button rs-button--ghost"
                    onClick={() => set({ sheetId: "", sheetUrl: null, sheetName: null, sheetTabs: [] })}
                  >
                    Use a new sheet
                  </button>
                  {picker ? (
                    <button type="button" className="rs-button rs-button--ghost" disabled={picking !== null} onClick={() => void pick("sheet")}>
                      Pick another sheet
                    </button>
                  ) : null}
                </span>
              ) : pasting ? (
                <input
                  className="au-input"
                  aria-label="Sheet link"
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={value.sheetId}
                  onChange={(e) => set({ sheetId: googleId(e.target.value), sheetUrl: null })}
                />
              ) : (
                <span className="au-gline">
                  <Pill>New sheet</Pill>
                  <span className="au-note">Made when you save, named after this automation.</span>
                  {picker ? (
                    <button type="button" className="rs-button rs-button--ghost" disabled={picking !== null} onClick={() => void pick("sheet")}>
                      Pick an existing sheet
                    </button>
                  ) : null}
                  <button type="button" className="rs-button rs-button--ghost" onClick={() => setPasting(true)}>
                    Paste a link instead
                  </button>
                </span>
              )}
              {waiting("sheet")}
            </div>
            <label className="au-field au-field--narrow">
              <span className="au-label">Tab</span>
              {value.sheetTabs?.length ? (
                <select className="au-input" value={value.tab} onChange={(e) => set({ tab: e.target.value })}>
                  {value.sheetTabs.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="au-input" value={value.tab} onChange={(e) => set({ tab: e.target.value })} />
              )}
            </label>
            <div className="au-field">
              <span className="au-label" id="au-gcolumns">
                Columns
              </span>
              <div className="au-chips" role="group" aria-labelledby="au-gcolumns">
                {value.columns.map((c) => (
                  <span key={c} className="au-chip">
                    {c}
                    <button
                      type="button"
                      className="au-chip-x"
                      aria-label={`Remove column ${c}`}
                      onClick={() => set({ columns: value.columns.filter((x) => x !== c) })}
                    >
                      <X size={11} aria-hidden />
                    </button>
                  </span>
                ))}
                <input
                  className="au-chip-input"
                  aria-label="Add a column"
                  placeholder="+ Column"
                  value={column}
                  onChange={(e) => setColumn(e.target.value)}
                  onKeyDown={columnKeys}
                  onBlur={addColumn}
                />
              </div>
              <span className="au-hint">
                The agent returns one row per item, with these columns in this order. Lotus writes the rows, not the
                agent.
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="au-gblock" data-on={value.driveOn || undefined}>
        <label className="au-check">
          <input type="checkbox" checked={value.driveOn} disabled={!connected && !value.driveOn} onChange={(e) => set({ driveOn: e.target.checked })} />
          <FileText size={14} strokeWidth={1.75} aria-hidden />
          Save a report file to Google Drive
          {connected ? null : <span className="au-note">(connect Google in Connectors first)</span>}
        </label>
        {value.driveOn ? (
          <div className="au-gblock-body">
            <div className="au-field">
              <label className="au-field">
                <span className="au-label">Folder</span>
                <input
                  className="au-input"
                  placeholder="My Drive — or paste a folder link Lotus made"
                  value={value.folderName && value.folder ? value.folderName : value.folder}
                  onChange={(e) => set({ folder: e.target.value, folderName: null })}
                />
              </label>
              {picker ? (
                <span className="au-gline">
                  <button type="button" className="rs-button rs-button--ghost" disabled={picking !== null} onClick={() => void pick("folder")}>
                    Pick a folder
                  </button>
                  {value.folder ? (
                    <button type="button" className="rs-button rs-button--ghost" onClick={() => set({ folder: "", folderName: null })}>
                      Use My Drive
                    </button>
                  ) : null}
                </span>
              ) : null}
              {waiting("folder")}
            </div>
            <div className="au-field">
              <span className="au-label" id="au-gformat">
                Format
              </span>
              <div className="au-daypicker" role="group" aria-labelledby="au-gformat">
                {FORMATS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className="au-day"
                    aria-pressed={value.format === f.key}
                    disabled={f.key === "csv" && csvNeedsSheet}
                    title={f.key === "csv" && csvNeedsSheet ? "A CSV file is the sheet's rows: add rows to a Google Sheet first" : undefined}
                    onClick={() => set({ format: f.key })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <span className="au-note">
              Next file: {value.format === "markdown" ? `${stem}.md` : value.format === "csv" ? `${stem}.csv` : stem}
            </span>
          </div>
        ) : null}
      </div>
      {pickError ? (
        <p className="au-error" role="alert">
          {pickError}
        </p>
      ) : null}
    </>
  );
}
