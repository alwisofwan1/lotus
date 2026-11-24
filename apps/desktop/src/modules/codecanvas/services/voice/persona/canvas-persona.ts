/**
 * Canvas personas: forkable voice identities loaded from markdown-with-frontmatter files
 * (Slice 1 of `plans/voice-narration-layer/`).
 *
 * Policy lives in `narration-rules.ts`; register lives here. A persona carries who is speaking —
 * the prompt body — plus the structured knobs a voice surface needs (voice id, speed, address).
 *
 * **The frontmatter is not YAML.** It is a deliberately small flat subset — `key: value` scalars
 * and `key:` followed by `- item` lists — parsed by hand. Two reasons: the schema is ours, and a
 * strict YAML parser throws where this loader must degrade gracefully instead (see
 * {@link parsePersonaFile}). `js-yaml` exists in `node_modules` only as a transitive dependency and
 * must not be imported.
 *
 * Adapted from `heardlabs/heard` (Apache-2.0) — `heard/persona.py`.
 */

import type { PersonaCalloutPools } from "../agent-done-callout";
import { BUNDLED_PERSONA_FILES } from "./bundled";

/** Frontmatter values: scalars, or string lists for pooled phrasings. */
export type PersonaMetaValue = string | string[];

export interface ParsedPersonaFile {
  meta: Record<string, PersonaMetaValue>;
  body: string;
}

const DELIMITER = "---";

/** Strip one layer of matching surrounding quotes, so `name: "aria"` yields `aria`. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.length >= 2 && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Split a persona file into its frontmatter metadata and its prompt body.
 *
 * A file with no opening `---` is treated as pure prompt body with no metadata — that is still a
 * valid persona, just one that is entirely a system prompt.
 */
export function parsePersonaFile(text: string): ParsedPersonaFile {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== DELIMITER) return { meta: {}, body: text.trim() };

  const closingAt = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closingAt === -1) return { meta: {}, body: text.trim() };

  const meta: Record<string, PersonaMetaValue> = {};
  let listKey: string | null = null;
  for (const line of lines.slice(1, closingAt)) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listKey) {
      (meta[listKey] as string[]).push(unquote(listItem[1]));
      continue;
    }
    const pair = /^([A-Za-z0-9_]+):(.*)$/.exec(line.trim());
    if (!pair) continue;
    const [, key, rest] = pair;
    if (rest.trim() === "") {
      listKey = key;
      meta[key] = [];
      continue;
    }
    listKey = null;
    meta[key] = unquote(rest);
  }

  return { meta, body: lines.slice(closingAt + 1).join("\n").trim() };
}

/** One place personas can be read from — a user directory, or the bundled set. */
export interface PersonaSource {
  /** The raw file text for `name`, or `null` when this source does not have it. */
  read(name: string): string | null;
}

/** A resolved voice identity. */
export interface CanvasPersona {
  /** The persona's declared name, falling back to the name it was requested under. */
  name: string;
  /** The prompt body — who is speaking. Empty for {@link CanvasPersona.isRaw}. */
  body: string;
  /** No register to apply: the surface keeps its own wording. */
  isRaw: boolean;
  /** Per-language finish-callout phrasings. Empty when the persona declares none. */
  callouts: PersonaCalloutPools;
}

/** The pass-through identity used when no source has the requested persona. */
const RAW_PERSONA: CanvasPersona = { name: "raw", body: "", isRaw: true, callouts: {} };

/** A frontmatter list value, or undefined when the key is absent or not a list. */
function listOf(value: PersonaMetaValue | undefined): readonly string[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

/**
 * Resolve a persona by name, taking the first source that has it — so a user fork shadows the
 * bundled original. An unknown name resolves to the raw pass-through rather than throwing: a typo
 * in a settings field must not take the voice channel down.
 */
export function loadPersona(name: string, sources: readonly PersonaSource[]): CanvasPersona {
  for (const source of sources) {
    const text = source.read(name);
    if (text === null) continue;
    const { meta, body } = parsePersonaFile(text);
    const declared = typeof meta.name === "string" ? meta.name.trim() : "";
    const callouts: PersonaCalloutPools = {};
    const en = listOf(meta.calloutsEn);
    const ja = listOf(meta.calloutsJa);
    if (en) callouts.en = en;
    if (ja) callouts.ja = ja;
    return { name: declared || name, body, isRaw: false, callouts };
  }
  return RAW_PERSONA;
}

/** The personas Lotus ships with. Lowest precedence — a user fork of the same name wins. */
export function bundledPersonaSource(): PersonaSource {
  return { read: (name) => BUNDLED_PERSONA_FILES[name] ?? null };
}

/**
 * The persona a `VoiceOutputSettings.tone` selects. `tone` stays the persisted key so the settings
 * payload on disk is unchanged; personas are the mechanism behind it, not a new setting.
 *
 * `"custom"` has no bundled file — it is built from the user's own instructions by the caller.
 */
export function personaNameForTone(tone: string | undefined): string {
  return tone?.trim() || "jarvis";
}
