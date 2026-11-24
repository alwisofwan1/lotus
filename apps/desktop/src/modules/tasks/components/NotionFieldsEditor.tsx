"use client";

import { useId, useMemo, type ReactNode } from "react";
import {
  notionVocabulary,
  type DataSourceSchema,
  type FieldMapping,
  type NotionSourceConfig,
  type PropertySchema,
} from "@/modules/tasks/services/notion-source";

/**
 * Which property is which ticket field, and the board's statuses in its own words (mockup
 * `SOURCES 03`, PLAN S18–S20). Shared by "Add a Notion database" and "Fields of …", so adding a
 * board and remapping it later are the same form.
 */

type FieldName = keyof FieldMapping;

export const NOTION_FIELDS: ReadonlyArray<{ name: FieldName; label: string; kinds: readonly string[]; hint?: string }> = [
  { name: "title", label: "Title", kinds: ["title"] },
  { name: "key", label: "Key", kinds: ["unique_id"], hint: "TKT-1008 style keys" },
  { name: "status", label: "Status", kinds: ["status"] },
  { name: "assignee", label: "Assignee", kinds: ["people"] },
  { name: "labels", label: "Labels", kinds: ["multi_select"] },
  { name: "parent", label: "Parent", kinds: ["relation"], hint: "a relation into this same database" },
];

/** The properties a field can be mapped to: the right type, and for Parent, a relation back into this board. */
function optionsFor(schema: DataSourceSchema, field: (typeof NOTION_FIELDS)[number]): PropertySchema[] {
  return schema.properties.filter(
    (p) => field.kinds.includes(p.kind) && (field.name !== "parent" || p.relationTarget === schema.id),
  );
}

/**
 * `kept` checked against the board as it is now: a field whose property is gone or changed type
 * takes what Notion suggests instead. A renamed property keeps its id, so it stays mapped.
 */
export function remappedFields(kept: FieldMapping, schema: DataSourceSchema, suggested: FieldMapping): FieldMapping {
  const next = { ...kept };
  for (const field of NOTION_FIELDS) {
    const id = kept[field.name];
    if (id && !optionsFor(schema, field).some((p) => p.id === id)) next[field.name] = suggested[field.name];
  }
  return next;
}

/** The status property the mapping points at, with its options and groups. */
export function mappedStatus(schema: DataSourceSchema, mapping: FieldMapping) {
  return mapping.status ? (schema.properties.find((p) => p.id === mapping.status)?.status ?? null) : null;
}

export function NotionFieldsEditor({
  schema,
  mapping,
  onChange,
}: {
  schema: DataSourceSchema;
  mapping: FieldMapping;
  onChange: (mapping: FieldMapping) => void;
}) {
  const status = useMemo(() => mappedStatus(schema, mapping), [mapping, schema]);
  const vocabulary = useMemo(() => notionVocabulary(status), [status]);

  return (
    <>
      <section className="tk-add-notion-section" aria-label="Fields">
        <h3 className="tk-add-notion-h">Fields — found automatically, change any</h3>
        <div className="tk-add-notion-fields">
          {NOTION_FIELDS.map((field) => (
            <label key={field.name} className="tk-add-notion-field">
              <span className="tk-add-notion-field-name">{field.label}</span>
              <select
                aria-label={field.label}
                value={mapping[field.name] ?? ""}
                onChange={(event) => onChange({ ...mapping, [field.name]: event.target.value || null })}
              >
                {field.name === "title" ? null : <option value="">— not used</option>}
                {optionsFor(schema, field).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {field.hint ? <span className="tk-add-notion-hint">{field.hint}</span> : null}
            </label>
          ))}
        </div>
      </section>

      <section className="tk-add-notion-section" aria-label="Statuses">
        <h3 className="tk-add-notion-h">Status, in this board’s words</h3>
        {status ? (
          <ul className="tk-add-notion-statuses">
            {status.groups.map((group) => (
              <li key={group.id}>
                <span className="tk-add-notion-group">
                  {group.name} · {group.optionIds.some((id) => vocabulary.open.includes(id)) ? "open" : "closed"}
                </span>
                {group.optionIds.map((id) => vocabulary.labels[id]).filter(Boolean).join(", ") || "—"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="tk-add-notion-note">No status field is used. Tickets show without a status.</p>
        )}
        <p className="tk-add-notion-note">Order and groups come from Notion. Lotus never renames a status.</p>
      </section>
    </>
  );
}

/**
 * What Lotus may change in this database (PLAN S21). The token can always write, so Read only is
 * kept by Lotus itself: Rust reads this choice from settings and refuses every write otherwise.
 */
export function NotionPermissionChoice({
  value,
  onChange,
}: {
  value: NotionSourceConfig["permission"];
  onChange: (value: NotionSourceConfig["permission"]) => void;
}) {
  const name = useId();
  return (
    <section className="tk-add-notion-section" aria-label="What Lotus may change">
      <h3 className="tk-add-notion-h">What Lotus may change</h3>
      <label className="tk-add-notion-choice">
        <input type="radio" name={name} checked={value === "read_only"} onChange={() => onChange("read_only")} />
        <span>
          <strong>Read only</strong> — list, open and delegate. Change tickets in Notion.
        </span>
      </label>
      <label className="tk-add-notion-choice">
        <input type="radio" name={name} checked={value === "manage"} onChange={() => onChange("manage")} />
        <span>
          <strong>Manage</strong> — change a ticket’s title, status, assignee and labels here. Lotus first checks
          nobody changed that field in Notion since you opened the ticket. Never comments, never deletes.
        </span>
      </label>
    </section>
  );
}

/**
 * "Match notes by key in <notes> · optional" (PLAN S37, mockup `SOURCES 03`'s footer). Drawn only
 * when there are notes to match — the caller passes their place's name, or nothing, and then this
 * option does not exist on screen at all (`SOURCES 05`).
 */
export function MatchNotesChoice({
  notesName,
  mark,
  checked,
  onChange,
}: {
  notesName: string;
  /** The mark of the place the notes live in, drawn before the words. */
  mark?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="tk-add-notion-match" title={`A ticket TKT-1008 opens the note TKT-1008.md in ${notesName}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {mark}
      <span>
        Match notes by key in <strong>{notesName}</strong>
        <span className="tk-add-notion-optional"> · optional</span>
      </span>
    </label>
  );
}
