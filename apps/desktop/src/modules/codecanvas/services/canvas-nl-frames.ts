import type {
  CanvasNodeRef,
  IntentDef,
  NlCanvasIntent,
  NlCommandContext,
  NlErrorResult,
  NodeNameResolution,
} from "./canvas-nl-command";
import { resolveFrame, tieredMatches, type FrameQuery, type FrameRef } from "./canvas-frames";

/**
 * Frames in the NL Command Bar (LOT2-129, DECISIONS 28): the local fast-path grammar and the Frame
 * name resolver. Pure and type-only coupled to canvas-nl-command, which owns the intent registry and
 * node-name resolution. English + Bahasa Indonesia.
 *
 *   create  "buat frame Auth dari T1 dan reviewer" / "make frame Auth from T1 and reviewer"
 *   move in "pindahkan T2 ke Bug triage"           / "move T2 to frame 2"
 *   move out "keluarkan T2 dari frame"             / "take T2 out of frame Auth"
 *   go to   "buka Auth" / "go to Auth" / "frame 2"
 */

const norm = (s: string): string => s.trim().replace(/\s+/g, " ");

export type { FrameQuery };

const MEMBER_SPLIT = /\s*(?:,|&|\+|\band\b|\bdan\b|\bserta\b)\s*/i;
const splitNames = (s: string): string[] => s.split(MEMBER_SPLIT).map((x) => x.trim().replace(/^["'“”]+|["'“”]+$/g, "")).filter(Boolean);
const cleanTitle = (s: string | undefined): string | undefined => {
  const t = s?.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
  return t || undefined;
};

/** "frame 2" / "the Auth" / "Auth" → a Frame query; `keyword` says the word "frame" was spoken. */
function parseFrameTarget(raw: string): { query: FrameQuery; keyword: boolean } | null {
  let s = norm(raw).replace(/^(?:the|si)\s+/i, "");
  const kw = /^frame\s+(.+)$/i.exec(s);
  const keyword = Boolean(kw);
  if (kw) s = kw[1].trim();
  if (!s) return null;
  if (keyword && /^\d{1,3}$/.test(s)) return { query: { index: Number.parseInt(s, 10) }, keyword };
  return { query: { name: s }, keyword };
}

const knownFrame = (name: string, frameNames: readonly string[] | undefined): boolean =>
  Boolean(frameNames && tieredMatches(frameNames, (n) => n, name, "loose").length > 0);

/** A move/go-to target is a Frame when "frame" was said, or the name matches a Frame that exists. */
function frameTarget(raw: string, frameNames: readonly string[] | undefined): FrameQuery | null {
  const t = parseFrameTarget(raw);
  if (!t) return null;
  if (t.keyword || (t.query.name !== undefined && knownFrame(t.query.name, frameNames))) return t.query;
  return null;
}

const queryFields = (q: FrameQuery) => (q.index !== undefined ? { frameIndex: q.index } : { frame: q.name as string });

const CREATE_RE =
  /^(?:buat(?:kan)?|bikin(?:kan)?|create|make|new|add|tambah(?:kan)?)\s+(?:a\s+|an\s+|sebuah\s+)?(?:new\s+|baru\s+)?frame(?:\s+(?:baru|new))?\s+(?:(.+?)\s+)?(?:dari|from|with|dengan|berisi)\s+(.+)$/i;
const LEAVE_RE =
  /^(?:keluarkan|keluarin|lepaskan|lepas|move|take|pull|remove|eject)\s+(.+?)\s+(?:out\s+of|from|dari|keluar\s+dari)\s+(?:the\s+|si\s+)?frame(?:\s+(.+))?$/i;
const MOVE_RE = /^(?:pindahkan|pindahin|pindah|move|taruh(?:kan)?|masukkan|masukin|put)\s+(.+?)\s+(?:ke(?:\s+dalam)?|to|into|in)\s+(.+)$/i;
const GOTO_RE =
  /^((?:buka|open|go\s+to|goto|pergi\s+ke|ke|show|fly\s+to|terbang\s+ke|tampilkan|lihat|fokus\s+ke|focus(?:\s+on)?|switch\s+to|pindah\s+ke)\s+)?(.+)$/i;

/**
 * Fast-path matcher for Frame commands. Returns one intent, or null to let the rest of the fast path
 * (and then the LLM) see the utterance. `frameNames` are the canvas's Frame titles: a target without
 * the word "frame" ("buka Auth", "pindahkan T2 ke Bug triage") only counts when it names a Frame, so
 * "buka browser" and "move Skye to the left" are left alone.
 */
export function matchFrameIntent(cmd: string, frameNames?: readonly string[]): NlCanvasIntent[] | null {
  const text = norm(cmd);

  const create = CREATE_RE.exec(text);
  if (create) {
    const members = splitNames(create[2]);
    if (members.length === 0) return null;
    const title = cleanTitle(create[1]);
    return [{ action: "create_frame", ...(title ? { title } : {}), members }];
  }

  const leave = LEAVE_RE.exec(text);
  if (leave) {
    const targets = splitNames(leave[1]);
    if (targets.length === 0) return null;
    const named = leave[2] ? parseFrameTarget(`frame ${leave[2]}`) : null;
    return [{ action: "leave_frame", targets, ...(named ? queryFields(named.query) : {}) }];
  }

  const move = MOVE_RE.exec(text);
  if (move) {
    const query = frameTarget(move[2], frameNames);
    const targets = splitNames(move[1]);
    if (query && targets.length > 0) return [{ action: "move_to_frame", targets, ...queryFields(query) }];
  }

  const go = GOTO_RE.exec(text);
  if (go) {
    const query = frameTarget(go[2], frameNames);
    // A bare name ("Auth") is not a command; it needs a verb or the word "frame".
    if (query && (go[1] || /^(?:the\s+|si\s+)?frame\s/i.test(go[2]))) return [{ action: "go_to_frame", ...queryFields(query) }];
  }

  return null;
}


// ─── Intent definitions ─────────────────────────────────────────────────────────

/** What the intent registry hands over: node-name resolution and its error shaping. */
export interface FrameIntentHelpers {
  str: (value: unknown) => string | null;
  resolveNodeByName: (name: string, refs: CanvasNodeRef[]) => NodeNameResolution;
  nameError: (target: string, reason: "not-found" | "ambiguous", noun?: string, candidates?: { id: string; label: string }[]) => NlErrorResult;
  candidatesOf: (r: NodeNameResolution) => { id: string; label: string }[] | undefined;
}

function queryOf(intent: { frame?: string; frameIndex?: number }): FrameQuery {
  return intent.frameIndex !== undefined ? { index: intent.frameIndex } : { name: intent.frame };
}

/** Frame refs in canvas order (the Frame Switcher's numbering). */
function frameRefsOf(nodeRefs: readonly CanvasNodeRef[]): FrameRef[] {
  return nodeRefs.filter((r) => r.kind === "frame").map((r) => ({ id: r.id, name: r.name }));
}

export function frameIntentDefs(h: FrameIntentHelpers): IntentDef[] {
  const { str, resolveNodeByName, nameError, candidatesOf } = h;
  /** A string-array arg, tolerant of a lone string; blanks dropped. */
  const strList = (value: unknown): string[] => {
    const arr = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return arr.map((v) => str(v)).filter((v): v is string => Boolean(v));
  };
  const frameQueryOf = (raw: Record<string, unknown>): FrameQuery | null => {
    const idx = typeof raw.frameIndex === "number" && Number.isInteger(raw.frameIndex) && raw.frameIndex > 0 ? raw.frameIndex : undefined;
    if (idx !== undefined) return { index: idx };
    const name = str(raw.frame);
    return name ? { name } : null;
  };
  /**
   * Resolve node names for a Frame command with the same matcher focus/close use. Frames themselves are
   * never members, and one unresolved name fails the whole command so nothing half-applies.
   */
  const resolveFrameableNodes = (names: readonly string[], ctx: NlCommandContext): { ids: string[]; names: string[] } | NlErrorResult => {
    const pool = ctx.nodeRefs.filter((r) => r.kind !== "frame" && r.kind !== "skill" && r.kind !== "skills");
    const ids: string[] = [];
    const out: string[] = [];
    for (const name of names) {
      const r = resolveNodeByName(name, pool);
      if (!r.ok) return nameError(name, r.reason, "node", candidatesOf(r));
      if (!ids.includes(r.id)) {
        ids.push(r.id);
        out.push(r.ref.name);
      }
    }
    return { ids, names: out };
  };
  return [
    {
      name: "create_frame",
      description: "Create a Frame (a named area on the canvas) around existing nodes, by their names.",
      destructive: false,
      speak: (i) => (i.action === "create_frame" ? `Creating frame${i.title ? ` ${i.title}` : ""}` : ""),
      promptSchema: () => `{"action":"create_frame","title":<optional Frame name>,"members":[<node name>,…]}  (a Frame around the named nodes)`,
      toolParams: () => ({
        type: "object",
        properties: {
          title: { type: "string", description: "Optional name for the new Frame." },
          members: { type: "array", items: { type: "string" }, description: "Names of the nodes to put in the Frame." },
        },
        required: ["members"],
      }),
      parse: (raw) => {
        const members = strList(raw.members);
        if (members.length === 0) return { error: "Which nodes should go in the Frame?" };
        const title = str(raw.title);
        return { action: "create_frame", ...(title ? { title } : {}), members };
      },
      resolve: (intent, ctx) => {
        if (intent.action !== "create_frame") return { error: "intent mismatch" };
        const r = resolveFrameableNodes(intent.members, ctx);
        if ("error" in r) return r;
        return {
          effect: { kind: "command", command: { kind: "create-frame", nodeIds: r.ids, ...(intent.title ? { title: intent.title } : {}) } },
          destructive: false,
          summary: `Create Frame${intent.title ? ` "${intent.title}"` : ""} from ${r.names.join(", ")}`,
        };
      },
    },
    {
      name: "move_to_frame",
      description: "Move nodes (by name) into an existing Frame, named or numbered (\"frame 2\").",
      destructive: false,
      speak: (i) => (i.action === "move_to_frame" ? `Moving ${i.targets.join(" and ")} into ${i.frame ?? `frame ${i.frameIndex}`}` : ""),
      promptSchema: () => `{"action":"move_to_frame","targets":[<node name>,…],"frame":<Frame name>}  (or "frameIndex":<1-based Frame number>)`,
      toolParams: () => ({
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "string" }, description: "Names of the nodes to move." },
          frame: { type: "string", description: "Name of the destination Frame." },
          frameIndex: { type: "number", description: "1-based Frame number, instead of a name." },
        },
        required: ["targets"],
      }),
      parse: (raw) => {
        const targets = strList(raw.targets);
        if (targets.length === 0) return { error: "Which nodes should I move?" };
        const q = frameQueryOf(raw);
        if (!q) return { error: "Which Frame should they go into?" };
        return { action: "move_to_frame", targets, ...(q.index !== undefined ? { frameIndex: q.index } : { frame: q.name }) };
      },
      resolve: (intent, ctx) => {
        if (intent.action !== "move_to_frame") return { error: "intent mismatch" };
        const frame = resolveFrame(frameRefsOf(ctx.nodeRefs), queryOf(intent), "loose");
        if (!frame.ok) return { error: frame.error };
        const r = resolveFrameableNodes(intent.targets, ctx);
        if ("error" in r) return r;
        return {
          effect: { kind: "command", command: { kind: "move-to-frame", nodeIds: r.ids, frameId: frame.id } },
          destructive: false,
          summary: `Move ${r.names.join(", ")} into ${frame.name}`,
        };
      },
    },
    {
      name: "leave_frame",
      description: "Take nodes (by name) out of their Frame, leaving them loose on the canvas.",
      destructive: false,
      speak: (i) => (i.action === "leave_frame" ? `Taking ${i.targets.join(" and ")} out of the frame` : ""),
      promptSchema: () => `{"action":"leave_frame","targets":[<node name>,…],"frame":<optional Frame name they must be in>}`,
      toolParams: () => ({
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "string" }, description: "Names of the nodes to take out of their Frame." },
          frame: { type: "string", description: "Optional: only if they are in this Frame." },
          frameIndex: { type: "number", description: "Optional 1-based Frame number, instead of a name." },
        },
        required: ["targets"],
      }),
      parse: (raw) => {
        const targets = strList(raw.targets);
        if (targets.length === 0) return { error: "Which nodes should I take out?" };
        const q = frameQueryOf(raw);
        return { action: "leave_frame", targets, ...(q ? (q.index !== undefined ? { frameIndex: q.index } : { frame: q.name }) : {}) };
      },
      resolve: (intent, ctx) => {
        if (intent.action !== "leave_frame") return { error: "intent mismatch" };
        let from: { id: string; name: string } | null = null;
        if (intent.frame !== undefined || intent.frameIndex !== undefined) {
          const f = resolveFrame(frameRefsOf(ctx.nodeRefs), queryOf(intent), "loose");
          if (!f.ok) return { error: f.error };
          from = f;
        }
        const r = resolveFrameableNodes(intent.targets, ctx);
        if ("error" in r) return r;
        const byId = new Map(ctx.nodeRefs.map((n) => [n.id, n]));
        for (const id of r.ids) {
          const ref = byId.get(id);
          if (from ? ref?.frameId !== from.id : !ref?.frameId) {
            return { error: from ? `${ref?.name ?? "That node"} is not in ${from.name}.` : `${ref?.name ?? "That node"} is not in a Frame.` };
          }
        }
        return {
          effect: { kind: "command", command: { kind: "move-to-frame", nodeIds: r.ids, frameId: undefined } },
          destructive: false,
          summary: `Take ${r.names.join(", ")} out of ${from ? from.name : "the Frame"}`,
        };
      },
    },
    {
      name: "go_to_frame",
      description: "Fly the camera to a Frame, by name or number (\"go to Auth\", \"frame 2\").",
      destructive: false,
      speak: (i) => (i.action === "go_to_frame" ? `Going to ${i.frame ?? `frame ${i.frameIndex}`}` : ""),
      promptSchema: () => `{"action":"go_to_frame","frame":<Frame name>}  (or "frameIndex":<1-based Frame number>)`,
      toolParams: () => ({
        type: "object",
        properties: {
          frame: { type: "string", description: "Name of the Frame." },
          frameIndex: { type: "number", description: "1-based Frame number, instead of a name." },
        },
      }),
      parse: (raw) => {
        const q = frameQueryOf(raw);
        if (!q) return { error: "Which Frame?" };
        return { action: "go_to_frame", ...(q.index !== undefined ? { frameIndex: q.index } : { frame: q.name }) };
      },
      resolve: (intent, ctx) => {
        if (intent.action !== "go_to_frame") return { error: "intent mismatch" };
        const f = resolveFrame(frameRefsOf(ctx.nodeRefs), queryOf(intent), "loose");
        if (!f.ok) return { error: f.error };
        return { effect: { kind: "command", command: { kind: "fly-to-frame", frameId: f.id } }, destructive: false, summary: `Go to ${f.name}` };
      },
    },
  ];
}
