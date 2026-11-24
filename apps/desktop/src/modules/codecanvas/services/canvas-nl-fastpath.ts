import type { CanvasCreateNodeKind } from "./commands/canvas-command";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import { MAX_NL_SPAWN_COUNT, NL_RUNNERS, type NlCanvasIntent } from "./canvas-nl-command";
import { resolveRunnerAlias } from "./runner-fuzzy";
import type { TaskDispatchMode } from "../types/canvas";
import { normalizeBrowserUrl } from "./browser-url";
import { matchFrameIntent } from "./canvas-nl-frames";

/**
 * Zero-token fast path for the NL command bar. Common, unambiguous single commands ("arrange",
 * "focus Skye", "close Rex", "create a terminal", "spawn a claude opus agent", "make Skye the lead")
 * are matched locally with regexes and resolved WITHOUT calling the haiku planner — instant and free.
 *
 * It is deliberately conservative: it only matches a confident single command and **bails to the LLM**
 * (returns `null`) for anything compound (contains "and"), content-bearing ("a note that says …"),
 * or unrecognized. The LLM planner stays the fallback, so accuracy never regresses — the fast path
 * only removes a model round-trip for the obvious cases. Output shape mirrors {@link parseNlIntents}.
 */

const RUNNER_SET = new Set<string>(NL_RUNNERS);

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  // Bahasa Indonesia — the user speaks Indonesian, so "buka dua agen" must fast-path (0 LLM) too.
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10,
};

/**
 * Spawn verbs (English + Bahasa Indonesia) shared by the spawn matchers.
 *
 * EXPORTED because the ⌘K catalog searches on the same vocabulary (command-sheet-items.ts). Before
 * it did, the two doors onto one engine disagreed: typing "open codex" in the bar fast-pathed to a
 * spawn, while the sheet's Launch rows — keyed on "launch run cli" — matched nothing and showed the
 * user no such command existed. A shared constant is what stops that drifting apart again.
 */
export const SPAWN_VERBS = "open|spawn|launch|start|run|buka|jalankan|buat|bikin|mulai|luncurkan|nyalakan";
/** Count tokens: digits + English + Indonesian number words. */
const SPAWN_COUNT_WORDS =
  "\\d+|one|two|three|four|five|six|seven|eight|nine|ten|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh";
/** Optional article (English + Indonesian "sebuah/se"). */
const SPAWN_ARTICLE = "a |an |sebuah ";
/** The "agent(s)" noun — English + Indonesian "agen". */
const AGENT_WORD = "agents?|agen";

/** Close/delete verbs — English + Bahasa Indonesia (the user speaks Indonesian). */
const CLOSE_VERBS = "close|clear|delete|remove|wipe|kill|tutup|hapus|hilangkan|bersihkan";
/**
 * Collective quantifiers (English + Indonesian) — "all/everything/semua/semuanya/dua-duanya".
 * Closed-class and tiny, so enumerating per language is cheap and robust (see plan §Slice 1).
 * Exported so the single-close guard and Slice 2's byType matcher can reason about the same set.
 */
export const QUANTIFIER_WORDS = "all|everything|every ?thing|semua(?:nya)?|dua-duanya";
/** Bare quantifier match (whole-string), used to guard the greedy single-close/focus matchers. */
const QUANTIFIER_ONLY_RE = new RegExp(`^(?:${QUANTIFIER_WORDS})$`, "i");
/**
 * "close all" / "tutup semua" / "clear the canvas" → close_all. A trailing generic collection noun
 * (node/nodes/canvas) is allowed, but NOT a specific type word (browser/terminal/…) — those are a
 * typed collective ("close all browsers"), handled as a byType close, not close_all.
 */
const CLOSE_ALL_RE = new RegExp(
  `^(?:${CLOSE_VERBS})\\s+(?:(?:${QUANTIFIER_WORDS})(?:\\s+(?:the\\s+)?nodes?)?|all\\s+(?:the\\s+)?nodes|(?:the\\s+)?canvas)$`,
  "i",
);

/** Node type words (English + Indonesian) → canonical node kind, for typed collectives ("all browsers"). */
const NODE_TYPE_WORD_TO_KIND: ReadonlyArray<[RegExp, string]> = [
  [/^browsers?$|^peramban$/, "browser"],
  [/^terminals?$/, "terminal"],
  [/^agents?$|^agen$/, "agent"],
  [/^tasks?$|^tugas$/, "task"],
  [/^notes?$|^catatan$/, "note"],
  [/^plans?$/, "plan"],
];
function nodeKindFromWord(word: string): string | null {
  const w = word.toLowerCase();
  for (const [re, kind] of NODE_TYPE_WORD_TO_KIND) if (re.test(w)) return kind;
  return null;
}
/** "close all browsers" / "tutup semua browser" / "close 2 browsers" → a typed collective close. */
const CLOSE_BY_TYPE_RE = new RegExp(
  `^(?:${CLOSE_VERBS})\\s+(?:(${QUANTIFIER_WORDS})|(${SPAWN_COUNT_WORDS}))\\s+(?:the\\s+)?([\\p{L}]+)$`,
  "iu",
);

function parseSpawnCount(token: string | undefined): number | null {
  if (!token) return 1;
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  return NUMBER_WORDS[token] ?? null;
}

/**
 * One spawn clause: `[verb] [article] [count] [more] [runner] [model] [agent(s)]`. Shared by the
 * single-spawn matcher and the compound splitter so both parse a clause identically. Capture groups:
 * 1=verb, 2=count, 3=runner, 4=model.
 */
const SPAWN_CLAUSE_RE = new RegExp(
  `^(?:(${SPAWN_VERBS})\\s+)?(?:${SPAWN_ARTICLE})?(?:(${SPAWN_COUNT_WORDS})\\s+)?(?:more\\s+)?(?:(claude|codex|cursor|cloud(?:\\s+code)?)\\s*)?(?:(opus|sonnet|haiku)\\s*)?(?:${AGENT_WORD})?$`,
);

/**
 * Match single- OR multi-agent spawns locally: "spawn a claude agent", "open 3 claude agents",
 * "launch two codex", "spawn 3 agents", "3 claude agents". Count-aware because "open N <runner>
 * agents" is the phrasing users actually speak — resolving it here saves a cold planner round-trip.
 * Returns N identical `spawn_agent` intents (the runner aggregates + auto-arranges them). Requires a
 * spawn verb OR the literal "agent(s)" word so it never swallows an unrelated phrase, and bails
 * (returns null) for counts outside 1–{@link MAX_NL_SPAWN_COUNT}. `q` is lowercased + single-spaced.
 */
function matchSpawnAgents(q: string): NlCanvasIntent[] | null {
  const m = q.match(SPAWN_CLAUSE_RE);
  if (!m) return null;
  const [, verb, countTok, runnerTok, modelTok] = m;
  const hasAgentsWord = new RegExp(`\\b(?:${AGENT_WORD})$`).test(q);
  // Strong-signal guard: must have a spawn verb or the word "agent(s)", AND at least one of
  // runner / count / agents-word — so a bare "open" (browser/url, handled earlier) never lands here.
  if (!verb && !hasAgentsWord) return null;
  if (!runnerTok && !countTok && !hasAgentsWord) return null;

  const count = parseSpawnCount(countTok);
  if (count === null || count < 1 || count > MAX_NL_SPAWN_COUNT) return null;

  const runner = (resolveRunnerAlias(runnerTok ?? "") ?? runnerTok ?? "claude") as AgentRunnerType;
  if (!RUNNER_SET.has(runner)) return null;

  const base: Extract<NlCanvasIntent, { action: "spawn_agent" }> = { action: "spawn_agent", runner };
  if (modelTok) base.model = modelTok;
  return Array.from({ length: count }, () => ({ ...base }));
}

/**
 * Match a compound made ENTIRELY of native spawn clauses joined by "and"/"dan" — "open claude and
 * cursor agents", "open 3 claude and 1 codex", "buka 2 claude dan 1 cursor". Each clause must name a
 * runner (a non-spawn clause → the whole thing is a mixed compound → bail to the LLM so accuracy never
 * regresses), and the utterance must carry at least one strong spawn signal (a verb or the "agent(s)"
 * word) so a bare "claude and codex" stays with the planner. Counts/models resolve per clause. `q` is
 * lowercased + single-spaced.
 */
function matchCompoundSpawn(q: string): NlCanvasIntent[] | null {
  const clauses = q.split(/\s+(?:and|dan)\s+/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length < 2) return null;
  const out: NlCanvasIntent[] = [];
  let strongSignal = false;
  for (const clause of clauses) {
    const m = clause.match(SPAWN_CLAUSE_RE);
    if (!m) return null;
    const [, verb, countTok, runnerTok, modelTok] = m;
    if (!runnerTok) return null; // a clause with no runner isn't a spawn → mixed compound → LLM
    if (verb || new RegExp(`\\b(?:${AGENT_WORD})$`).test(clause)) strongSignal = true;
    const count = parseSpawnCount(countTok);
    if (count === null || count < 1 || count > MAX_NL_SPAWN_COUNT) return null;
    if (out.length + count > MAX_NL_SPAWN_COUNT) return null;
    const runner = (resolveRunnerAlias(runnerTok) ?? runnerTok) as AgentRunnerType;
    if (!RUNNER_SET.has(runner)) return null;
    const base: Extract<NlCanvasIntent, { action: "spawn_agent" }> = { action: "spawn_agent", runner };
    if (modelTok) base.model = modelTok;
    for (let i = 0; i < count; i++) out.push({ ...base });
  }
  return strongSignal ? out : null;
}

export interface LocalMatchCtx {
  /** Node kinds the bar may create — gates `create_node` so only real kinds match. */
  nodeKinds: readonly CanvasCreateNodeKind[];
  /** Live agent handles — enables direct-address dispatch ("Rowan, …") without the LLM. */
  agentNames?: readonly string[];
  /** Titles of the canvas's Frames: lets "buka Auth" / "pindahkan T2 ke Bug triage" fast-path without the word "frame". */
  frameNames?: readonly string[];
}

function browserTargetFromPhrase(value: string): string | undefined {
  const m = value.trim().toLowerCase().match(/^browser\s+(\d+)$/);
  return m ? `Browser ${m[1]}` : undefined;
}

function matchBrowserNavigation(q: string): NlCanvasIntent[] | null {
  const polite = q.replace(/^(?:tolong|please)\s+/, "");

  {
    const m = polite.match(
      /^(?:di|in|on)\s+(?:the\s+)?(browser(?:\s+\d+)?)\s+(?:(?:tolong|please)\s+)?(?:navigate|navigasi|open|buka)(?:\s+(?:to|ke))?\s+(.+?)(?:\s+(?:and|dan)\s+.*)?$/,
    );
    if (m) {
      const target = browserTargetFromPhrase(m[1]);
      return [{ action: "navigate_browser", url: normalizeBrowserUrl(m[2]), ...(target ? { target } : {}) }];
    }
  }

  {
    const m = polite.match(
      /^(?:(?:focus|fokus)(?:\s+(?:ke|on))?\s+)?(browser(?:\s+\d+)?)\s+(?:and|dan)\s+(?:navigate|navigasi|open|buka)(?:\s+(?:to|ke))?\s+(.+)$/,
    );
    if (m) {
      const target = browserTargetFromPhrase(m[1]);
      return [{ action: "navigate_browser", url: normalizeBrowserUrl(m[2]), ...(target ? { target } : {}) }];
    }
  }

  {
    const m = polite.match(/^(?:navigate|navigasi|open|buka)\s+(?:the\s+)?(browser(?:\s+\d+)?)(?:\s+(?:to|ke))\s+(.+)$/);
    if (m) {
      const target = browserTargetFromPhrase(m[1]);
      return [{ action: "navigate_browser", url: normalizeBrowserUrl(m[2]), ...(target ? { target } : {}) }];
    }
  }

  {
    const m = polite.match(/^(?:open|buka)\s+(.+?)\s+(?:di|in|on)\s+(?:the\s+)?(browser(?:\s+\d+)?)$/);
    if (m) {
      const target = browserTargetFromPhrase(m[2]);
      return [{ action: "navigate_browser", url: normalizeBrowserUrl(m[1]), ...(target ? { target } : {}) }];
    }
  }

  return null;
}

export function matchLocalIntent(text: string, ctx: LocalMatchCtx): NlCanvasIntent[] | null {
  const raw = text.trim();
  if (!raw) return null;

  // Dispatch ("tell/ask <name> to <task>") is matched FIRST and BEFORE the compound guard below: the
  // task is free-form text delivered verbatim to the agent, so an "and" inside it ("…add login and
  // validation") must NOT bail to the LLM — that's the latency the user feels on voice dispatch. The
  // tell/ask anchor means this never swallows a compound canvas command (those don't start with it).
  {
    const m = raw.match(/^(?:tell|ask)\s+(.+?)\s+to\s+(.+)$/i);
    if (m) return [{ action: "dispatch", target: m[1].trim(), task: m[2].trim() }];
  }

  // Direct address to a LIVE agent: "<Name>, <text>" / "<Name>: <text>" / "hey <Name> <text>". The
  // whole message — a task OR a question ("Rowan, what's your favorite color?") — is delivered
  // verbatim; the agent's terminal IS the chat. Gated on a known handle so a normal sentence that
  // happens to start with a botanical word ("Sage advice for later") never misfires. Runs before the
  // compound guard because conversational text routinely contains "and".
  if (ctx.agentNames && ctx.agentNames.length > 0) {
    const known = new Set(ctx.agentNames.map((n) => n.trim().toLowerCase()));
    const addressed =
      raw.match(/^([\p{L}][\p{L}\d _-]*?)\s*[,:]\s*(.+)$/u) ?? // "Rowan, …" / "Rowan: …"
      raw.match(/^(?:hey|hi|yo|ok|okay)\s+([\p{L}][\p{L}\d_-]*)\s+(.+)$/iu); // "hey Rowan …"
    if (addressed && known.has(addressed[1].trim().toLowerCase())) {
      return [{ action: "dispatch", target: addressed[1].trim(), task: addressed[2].trim() }];
    }
  }

  // Canvas commands (below) are keyword/anchored matches, so a trailing sentence terminator from
  // dictation or natural phrasing ("Close all.", "arrange the canvas.") would break them — e.g.
  // "Close all." used to miss close_all (anchored on `all$`) and fall through to closing a node
  // literally named "all.". Strip it here. The verbatim dispatch blocks above already ran on `raw`,
  // so a question's trailing "?" is preserved for the agent.
  const cmd = raw.replace(/[.!?。？！]+$/u, "").trimEnd();
  const q = cmd.toLowerCase().replace(/\s+/g, " ");

  {
    const browserNavigation = matchBrowserNavigation(q);
    if (browserNavigation) return browserNavigation;
  }

  // Frames (LOT2-129). Before the compound guard: "buat frame Auth dari T1 dan reviewer" has a
  // legitimate "dan". Anchored on the word "frame" or a known Frame title, so other verbs are left alone.
  {
    const frame = matchFrameIntent(cmd, ctx.frameNames);
    if (frame) return frame;
  }

  // Compound requests ("create a terminal and a note" / "… dan …") and structured content are the
  // LLM's job — the fast path stays single-intent so it never mis-splits a sentence. Indonesian "dan"
  // is guarded alongside English "and" (the user speaks Indonesian). EXCEPTION: a compound made
  // entirely of spawn clauses ("open claude and cursor agents") just concatenates spawn intents, so
  // it resolves locally (0-token) instead of paying the planner round-trip.
  if (/\b(?:and|dan)\b/.test(q)) {
    const compoundSpawn = matchCompoundSpawn(q);
    return compoundSpawn ?? null;
  }

  // arrange / tidy (EN + ID: rapikan / rapihkan / atur / bereskan / tata — the user speaks Indonesian)
  if (/^(?:arrange|tidy(?: up)?|auto[- ]?layout|organi[sz]e|clean ?up|rapi(?:kan|hkan|in)?|atur|bereskan|tata)(?: the)?(?: canvas| kanvas)?$/.test(q)) {
    return [{ action: "arrange" }];
  }

  // App/project navigation (checked EARLY, before the generic close/focus matchers below could steal
  // "close project X" / "go to project X"). Every project matcher is anchored on an explicit
  // project/proyek keyword, so "open youtube" (browser) and "go to Skye" (focus) are never mistaken
  // for a project switch. "canvas"/"kanvas" is deliberately EXCLUDED from close_project so
  // "close the canvas" keeps meaning close_all (clear all nodes).
  // back to the previous project / go to the last project / proyek sebelumnya / balik ke proyek tadi.
  // Checked before the generic switch matcher; emits the "previous" anaphor the resolver maps to the
  // most-recently-opened other project. Anchored on a previous-word + project noun so it never fires
  // on a bare "back"/"go" (which the browser-back / focus matchers own).
  if (/^(?:(?:go|switch|change|jump)\s+)?(?:back\s+)?(?:to\s+)?(?:the\s+)?(?:previous|last|prior)\s+(?:project|canvas|kanvas|workspace)$/i.test(cmd)) {
    return [{ action: "switch_project", target: "previous" }];
  }
  if (/^(?:(?:kembali|balik|pindah)\s+)?(?:ke\s+)?(?:proyek|kanvas)\s+(?:sebelumnya|tadi|terakhir|barusan)$/i.test(cmd)) {
    return [{ action: "switch_project", target: "previous" }];
  }
  {
    // switch to project X / pindah ke proyek X / open project X / go to canvas X
    const m = cmd.match(
      /^(?:switch|change|pindah|ganti|beralih|go|open|buka|load|muat)\s+(?:to\s+|ke\s+)?(?:the\s+)?(?:project|proyek|canvas|kanvas|workspace)\s+(.+)$/i,
    );
    if (m) return [{ action: "switch_project", target: m[1].trim() }];
  }
  // close this/the/current project / tutup proyek (ini) — the active project. No target. Checked
  // BEFORE the named form so a trailing demonstrative ("ini"/"this") isn't captured as a project name.
  if (/^(?:close|exit|leave|tutup|keluar)(?:\s+(?:this|the|current|from|dari))?\s+(?:project|proyek|workspace)(?:\s+(?:ini|saat ini))?$/i.test(cmd)) {
    return [{ action: "close_project" }];
  }
  // close project X / tutup proyek X (named — before the generic close matcher below)
  {
    const m = cmd.match(/^(?:close|tutup)\s+(?:project|proyek|workspace)\s+(.+)$/i);
    if (m) return [{ action: "close_project", target: m[1].trim() }];
  }
  // create a new project / buat proyek baru (NOT "open/buka" — those browse or switch)
  if (/^(?:new|create|add|make|buat|bikin|tambah)\s+(?:a\s+)?(?:new\s+)?(?:project|proyek|kanvas|workspace)(?:\s+(?:baru))?$/i.test(cmd)) {
    return [{ action: "new_project" }];
  }
  // open settings / buka pengaturan
  if (/^(?:open|show|go to|buka|tampilkan|lihat)\s+(?:the\s+)?(?:canvas\s+)?(?:settings?|pengaturan|setelan|preferences?|preferensi)$/i.test(cmd)) {
    return [{ action: "open_page", page: "settings" }];
  }
  // browse canvases / buka proyek (the gallery) / show all projects
  if (/^(?:open|show|browse|view|list|buka|tampilkan|lihat|jelajahi)\s+(?:the\s+|all\s+|semua\s+)?(?:canvases|canvas gallery|projects|proyek|galeri(?:\s+canvas)?|gallery)$/i.test(cmd)) {
    return [{ action: "open_page", page: "canvases" }];
  }

  // open browser (standalone) / open <url> — EN + ID (buka/navigasi/kunjungi/akses/go to/pergi ke).
  // Indonesian parity so "buka https://…" opens a browser node, not falling to the LLM. Anchored on a
  // URL-shaped argument so "buka pengaturan" (settings) / "buka proyek X" (switch) / "buka dua agen"
  // (spawn) — all matched earlier — are never mistaken for a URL.
  if (/^(?:open|buka)\s+(?:a |the )?(?:browser|peramban)$/.test(q)) return [{ action: "open_browser" }];
  {
    const m = cmd.match(
      /^(?:open|buka|kunjungi|akses|(?:navigasi|navigate)(?:\s+(?:ke|to))?|(?:go|pergi)\s+(?:to|ke))\s+(https?:\/\/\S+|localhost(?::\d+)?(?:\/\S*)?|[\w-]+\.[\w.-]+\S*)$/i,
    );
    if (m) return [{ action: "open_browser", url: m[1] }];
  }

  // snapshot the browser → a snapshot_browser intent (resolves to a dispatch to an agent that
  // captures its own paired browser). EN + ID: "snapshot browser", "screenshot the page",
  // "ambil snapshot halamannya", "tangkap layar browser", "potret halaman".
  if (
    /^(?:take\s+(?:a\s+)?)?(?:snapshot|screenshot|capture|potret|tangkap(?:\s+layar)?|ambil(?:\s+(?:snapshot|screenshot|tangkapan(?:\s+layar)?|gambar|foto))?)\s+(?:of\s+|dari\s+)?(?:the\s+|si\s+)?(?:browser(?:\s+node)?|peramban|halaman(?:nya)?|page|layar)$/.test(
      q,
    )
  ) {
    return [{ action: "snapshot_browser" }];
  }

  // spawn agents — one or many ("spawn a claude agent", "open 3 claude agents", "launch two codex").
  {
    const spawn = matchSpawnAgents(q);
    if (spawn) return spawn;
  }

  // make <name> the lead
  {
    const m = cmd.match(/^(?:make|promote|set)\s+(.+?)\s+(?:as\s+|to\s+)?(?:the\s+)?lead(?:\s+orchestrator)?$/i);
    if (m) return [{ action: "make_lead", target: m[1].trim() }];
  }
  // jadikan <name> (sebagai) lead / pemimpin / ketua — Indonesian at parity with the English form.
  {
    const m = cmd.match(/^(?:jadikan|angkat|tunjuk|tetapkan)\s+(.+?)\s+(?:sebagai\s+|jadi\s+|menjadi\s+)?(?:lead|pemimpin|ketua|orchestrator)(?:\s+orchestrator)?$/i);
    if (m) return [{ action: "make_lead", target: m[1].trim() }];
  }

  // run task <name> [with the team] — EN + ID (jalankan task/tugas X [dengan tim]).
  {
    const m = cmd.match(
      /^(?:run|jalankan|mulai)\s+(?:the\s+)?(?:task|tugas)\s+(.+?)(\s+(?:with the team|as a team|on the team|dengan tim|dengan team|bareng tim|sebagai tim))?$/i,
    );
    if (m) {
      const mode: TaskDispatchMode = m[2] ? "team" : "single";
      return [{ action: "run_task", target: m[1].trim(), mode }];
    }
  }

  // create a <kind> [node]  (bare — content-bearing creates go to the LLM)
  {
    const m = q.match(/^(?:create|add|new|make|spawn|open|buat|bikin|buka|tambah)\s+(?:a |an |the )?(terminal|note|plan|task|context|critic|human[- ]?gate|team|music(?: player)?|player|musik)(?: node)?$/);
    if (m) {
      const kind = m[1]
        .replace(/human[- ]?gate/, "human-gate")
        .replace(/^(?:music(?: player)?|player|musik)$/, "music") as CanvasCreateNodeKind;
      if (ctx.nodeKinds.includes(kind)) return [{ action: "create_node", nodeType: kind }];
    }
  }

  // recover <name>  (EN + ID: pulihkan / sambung(kan) ulang / mulai ulang / nyalakan ulang)
  {
    const m = cmd.match(/^(?:recover|reconnect|restart|pulihkan|sambung(?:kan)?\s+ulang|mulai\s+ulang|nyalakan\s+ulang|hidupkan\s+ulang)\s+(.+)$/i);
    if (m) return [{ action: "recover", target: m[1].trim() }];
  }

  // close all / close everything / clear the canvas / tutup semua → close_all (checked before single
  // close so a bare quantifier isn't parsed as closing a node literally named "all"/"semua"). Immediate.
  if (CLOSE_ALL_RE.test(cmd)) {
    return [{ action: "close_all" }];
  }

  // TYPED collective: "close all browsers" / "tutup semua browser" / "close 2 browsers" → byType.
  // Placed before the greedy single-close so a quantifier+type phrase is never read as a literal name
  // (the "close semua browser" bug). Only fires when the trailing word is a known node type.
  {
    const m = cmd.match(CLOSE_BY_TYPE_RE);
    if (m) {
      const kind = nodeKindFromWord(m[3]);
      if (kind) {
        const count = m[2] ? parseSpawnCount(m[2]) : null;
        if (count && count >= 1 && count <= MAX_NL_SPAWN_COUNT) {
          return [{ action: "close", target: { kind: "byType", nodeType: kind, quantifier: "count", count } }];
        }
        if (!m[2]) return [{ action: "close", target: { kind: "byType", nodeType: kind, quantifier: "all" } }];
      }
    }
  }

  // Anaphoric close: "close them" / "tutup mereka" / "tutup yang tadi" → the nodes the previous turn
  // touched (resolved against dialogue state downstream). Only when the pronoun is the WHOLE target.
  {
    const m = cmd.match(/^(?:close|delete|remove|kill|tutup|hapus)\s+(?:them|those|these|it|that|mereka|itu|ini|yang tadi)$/i);
    if (m) return [{ action: "close", target: { kind: "lastMentioned" } }];
  }

  // close/delete <name>  (applied immediately — close is no longer gated by confirmation). Includes
  // Indonesian close verbs; a leading collective quantifier we couldn't resolve to a type bails to the
  // LLM rather than closing a node literally named "all …"/"semua …".
  {
    const m = cmd.match(new RegExp(`^(?:${CLOSE_VERBS})\\s+(.+)$`, "i"));
    if (m) {
      const target = m[1].trim();
      if (QUANTIFIER_ONLY_RE.test(target.split(/\s+/)[0] ?? "")) return null;
      return [{ action: "close", target }];
    }
  }

  // focus <name>  (a leading quantifier — "focus all browsers" — isn't a single-node focus → LLM).
  // Indonesian verbs (fokus ke / pilih / pergi ke) at parity with English — the user speaks Indonesian.
  {
    const m = cmd.match(/^(?:focus(?: on)?|go to|select|jump to|fokus(?: ke| pada)?|pergi ke|pilih)\s+(.+)$/i);
    if (m) {
      const target = m[1].trim();
      if (QUANTIFIER_ONLY_RE.test(target.split(/\s+/)[0] ?? "")) return null;
      return [{ action: "focus", target }];
    }
  }

  return null; // no confident local match → fall back to the LLM planner
}
