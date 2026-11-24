import { describe, expect, it } from "vitest";
import { matchLocalIntent } from "../canvas-nl-fastpath";

const ctx = { nodeKinds: ["terminal", "note", "plan", "task", "context", "critic", "human-gate", "team", "music"] as const };
const match = (t: string) => matchLocalIntent(t, ctx);

describe("matchLocalIntent (0-token fast path)", () => {
  it("matches arrange/tidy phrasings", () => {
    for (const t of ["arrange", "arrange the canvas", "tidy up", "auto-layout", "organize the canvas"]) {
      expect(match(t)).toEqual([{ action: "arrange" }]);
    }
  });

  it("matches create_node for known kinds, gated by nodeKinds", () => {
    expect(match("create a terminal")).toEqual([{ action: "create_node", nodeType: "terminal" }]);
    expect(match("add a note")).toEqual([{ action: "create_node", nodeType: "note" }]);
    expect(match("new human gate node")).toEqual([{ action: "create_node", nodeType: "human-gate" }]);
    // a kind not offered by ctx falls through to the LLM
    expect(matchLocalIntent("create a terminal", { nodeKinds: ["note"] as const })).toBeNull();
  });

  it("matches the music player via its natural synonyms", () => {
    for (const t of ["open music player", "add a music player", "create music", "open the player", "buat musik"]) {
      expect(match(t)).toEqual([{ action: "create_node", nodeType: "music" }]);
    }
    // "open Wesley"-style spawns must not be swallowed by the music rule
    expect(match("open player")).toEqual([{ action: "create_node", nodeType: "music" }]);
  });

  it("matches focus / close / recover with the target as the remainder", () => {
    expect(match("focus Skye")).toEqual([{ action: "focus", target: "Skye" }]);
    expect(match("go to Terminal 1")).toEqual([{ action: "focus", target: "Terminal 1" }]);
    expect(match("close Rex")).toEqual([{ action: "close", target: "Rex" }]);
    expect(match("delete the old note")).toEqual([{ action: "close", target: "the old note" }]);
    expect(match("recover Terminal 1")).toEqual([{ action: "recover", target: "Terminal 1" }]);
  });

  it("matches open_browser standalone and with a url", () => {
    expect(match("open a browser")).toEqual([{ action: "open_browser" }]);
    expect(match("open localhost:3000")).toEqual([{ action: "open_browser", url: "localhost:3000" }]);
    expect(match("open https://example.com/x")).toEqual([{ action: "open_browser", url: "https://example.com/x" }]);
  });

  it("Gap A: fast-paths Indonesian open/navigate <url> to open_browser", () => {
    expect(match("buka https://example.com")).toEqual([{ action: "open_browser", url: "https://example.com" }]);
    expect(match("buka example.com")).toEqual([{ action: "open_browser", url: "example.com" }]);
    expect(match("navigasi ke example.com")).toEqual([{ action: "open_browser", url: "example.com" }]);
    expect(match("navigate to localhost:5173")).toEqual([{ action: "open_browser", url: "localhost:5173" }]);
    expect(match("kunjungi example.com/docs")).toEqual([{ action: "open_browser", url: "example.com/docs" }]);
    expect(match("buka browser")).toEqual([{ action: "open_browser" }]);
    expect(match("buka peramban")).toEqual([{ action: "open_browser" }]);
  });

  it("Gap A: does not mistake Indonesian project/settings/spawn 'buka' for a browser url", () => {
    expect(match("buka pengaturan")).toEqual([{ action: "open_page", page: "settings" }]);
    expect(match("buka proyek Demo")).toEqual([{ action: "switch_project", target: "Demo" }]);
    // A bare Indonesian spawn ("buka dua agen") must still spawn agents, not open a browser.
    expect(match("buka dua agen")?.[0]?.action).toBe("spawn_agent");
  });

  it("Gap B: fast-paths snapshot-the-browser to a snapshot_browser intent (EN + ID)", () => {
    expect(match("snapshot browser")).toEqual([{ action: "snapshot_browser" }]);
    expect(match("snapshot the browser")).toEqual([{ action: "snapshot_browser" }]);
    expect(match("screenshot the page")).toEqual([{ action: "snapshot_browser" }]);
    expect(match("take a snapshot of the browser")).toEqual([{ action: "snapshot_browser" }]);
    expect(match("ambil snapshot halamannya")).toEqual([{ action: "snapshot_browser" }]);
    expect(match("tangkap layar browser")).toEqual([{ action: "snapshot_browser" }]);
    expect(match("potret halaman")).toEqual([{ action: "snapshot_browser" }]);
  });

  it("matches Indonesian browser navigation to the current browser", () => {
    expect(match("Tolong fokus ke browser dan navigasi ke YouTube")).toEqual([
      { action: "navigate_browser", url: "https://www.youtube.com/" },
    ]);
    expect(match("Di browser tolong buka YouTube dan putar musik apapun")).toEqual([
      { action: "navigate_browser", url: "https://www.youtube.com/" },
    ]);
  });

  it("matches spawn_agent with runner + optional model, no brief", () => {
    expect(match("spawn a claude agent")).toEqual([{ action: "spawn_agent", runner: "claude" }]);
    expect(match("launch codex")).toEqual([{ action: "spawn_agent", runner: "codex" }]);
    expect(match("open cloud agent")).toEqual([{ action: "spawn_agent", runner: "claude" }]);
    expect(match("spawn a claude opus agent")).toEqual([{ action: "spawn_agent", runner: "claude", model: "opus" }]);
  });

  it("does not treat CCS/CSP as native fast-path runners; use custom runners for profiles", () => {
    expect(match("spawn ccs agent")).toBeNull();
    expect(match("spawn csp agent")).toBeNull();
  });

  it("matches count-based spawn (the 'open N <runner> agents' voice command) — the common hot path", () => {
    // "open" verb + a count is the phrasing the user actually speaks; it must resolve locally (0 LLM).
    expect(match("open 3 claude agents")).toEqual([
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
    ]);
    expect(match("open 2 claude")).toEqual([
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
    ]);
    // number words, other verbs, default runner, and model all resolve locally too.
    expect(match("launch two codex agents")).toEqual([
      { action: "spawn_agent", runner: "codex" },
      { action: "spawn_agent", runner: "codex" },
    ]);
    expect(match("spawn 3 agents")).toEqual([
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
    ]);
    expect(match("3 claude agents")).toEqual([
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
    ]);
    expect(match("open 2 claude opus agents")).toEqual([
      { action: "spawn_agent", runner: "claude", model: "opus" },
      { action: "spawn_agent", runner: "claude", model: "opus" },
    ]);
  });

  it("fast-paths Bahasa Indonesia spawn phrasings (0 LLM) — the user speaks Indonesian", () => {
    const claude = { action: "spawn_agent", runner: "claude" };
    expect(match("buka dua agen")).toEqual([claude, claude]);
    expect(match("buka 2 claude")).toEqual([claude, claude]);
    expect(match("jalankan tiga claude agents")).toEqual([claude, claude, claude]);
    expect(match("buat satu codex agen")).toEqual([{ action: "spawn_agent", runner: "codex" }]);
  });

  it("bails to the LLM for absurd or ambiguous spawn counts, and never mis-fires on other commands", () => {
    expect(match("open 51 claude agents")).toBeNull(); // outside the per-command circuit breaker
    expect(match("open a browser")).toEqual([{ action: "open_browser" }]); // browser still wins
    expect(match("open localhost:3000")).toEqual([{ action: "open_browser", url: "localhost:3000" }]);
    expect(match("create a terminal")).toEqual([{ action: "create_node", nodeType: "terminal" }]); // not a spawn
    expect(match("close all")).toEqual([{ action: "close_all" }]);
  });

  it("matches make_lead and dispatch", () => {
    expect(match("make Skye the lead")).toEqual([{ action: "make_lead", target: "Skye" }]);
    expect(match("promote Rex to lead")).toEqual([{ action: "make_lead", target: "Rex" }]);
    expect(match("tell Skye to fix the bug")).toEqual([{ action: "dispatch", target: "Skye", task: "fix the bug" }]);
  });

  it("treats a direct address to a live agent as a dispatch — including a question", () => {
    const withAgents = { ...ctx, agentNames: ["Rowan", "Sage"] };
    expect(matchLocalIntent("Rowan, what's your favorite color?", withAgents)).toEqual([
      { action: "dispatch", target: "Rowan", task: "what's your favorite color?" },
    ]);
    expect(matchLocalIntent("Sage: refactor the auth module and add tests", withAgents)).toEqual([
      { action: "dispatch", target: "Sage", task: "refactor the auth module and add tests" },
    ]);
    expect(matchLocalIntent("hey Rowan can you check the build", withAgents)).toEqual([
      { action: "dispatch", target: "Rowan", task: "can you check the build" },
    ]);
  });

  it("does not mistake a normal sentence starting with a botanical word for an address", () => {
    const withAgents = { ...ctx, agentNames: ["Sage"] };
    // "Sage" is a real word; without a known-handle match on the prefix it must NOT become a dispatch.
    expect(matchLocalIntent("create a note that says hi", withAgents)).toBeNull();
    // A comma sentence whose prefix isn't an agent handle falls through too.
    expect(matchLocalIntent("first, create a terminal", withAgents)).toBeNull();
  });

  it("matches dispatch with an 'and' in the task (verbatim) and multi-word agent names", () => {
    // The task is free-form text for the agent — an inner "and" must NOT bail to the LLM (latency).
    expect(match("tell Rowan to add a login form and validation")).toEqual([
      { action: "dispatch", target: "Rowan", task: "add a login form and validation" },
    ]);
    // Lazy name capture handles a multi-word handle up to the " to " separator.
    expect(match("ask Tech Lead to ship it")).toEqual([{ action: "dispatch", target: "Tech Lead", task: "ship it" }]);
  });

  it("matches close_all phrasings, and keeps single close for a named target", () => {
    for (const t of ["close all", "close everything", "clear the canvas", "clear canvas", "close all nodes", "close all the nodes"]) {
      expect(match(t)).toEqual([{ action: "close_all" }]);
    }
    expect(match("close Rex")).toEqual([{ action: "close", target: "Rex" }]);
  });

  it("matches collective quantifiers across English + Indonesian verbs → close_all (the user speaks Indonesian)", () => {
    // Regression: "close semua" / "tutup semua" bailed or (with an id verb) closed a node literally
    // named "semua". A bare collective quantifier — in either language — is close_all.
    for (const t of [
      "close semua",
      "tutup semua",
      "tutup semuanya",
      "hapus semua",
      "tutup semua node",
      "tutup semuanya.",
      "close everything",
    ]) {
      expect(match(t)).toEqual([{ action: "close_all" }]);
    }
  });

  it("fast-paths a TYPED collective close → byType (the 'close semua browser' fix), en + id", () => {
    const allBrowsers = [{ action: "close", target: { kind: "byType", nodeType: "browser", quantifier: "all" } }];
    for (const t of [
      "close all browsers",
      "close semua browser",
      "tutup semua browser",
      "tutup semua browsers",
      "close all the browsers",
      "close semua browser.",
    ]) {
      expect(match(t)).toEqual(allBrowsers);
    }
    expect(match("tutup semua terminal")).toEqual([
      { action: "close", target: { kind: "byType", nodeType: "terminal", quantifier: "all" } },
    ]);
  });

  it("fast-paths a COUNTED collective close → byType/count (en + id numerals)", () => {
    expect(match("close 2 browsers")).toEqual([
      { action: "close", target: { kind: "byType", nodeType: "browser", quantifier: "count", count: 2 } },
    ]);
    expect(match("tutup 2 browser")).toEqual([
      { action: "close", target: { kind: "byType", nodeType: "browser", quantifier: "count", count: 2 } },
    ]);
    expect(match("tutup tiga terminal")).toEqual([
      { action: "close", target: { kind: "byType", nodeType: "terminal", quantifier: "count", count: 3 } },
    ]);
  });

  it("bails to the LLM when a quantifier close has no recognizable node type (never a literal 'all …' name)", () => {
    // Guard: "close all my widgets" must NOT become close of a node literally named "all my widgets".
    expect(match("close all my widgets")).toBeNull();
    expect(match("tutup semua yang tadi")).toBeNull();
    // A plain named close is unaffected.
    expect(match("close Rex")).toEqual([{ action: "close", target: "Rex" }]);
    expect(match("tutup Rex")).toEqual([{ action: "close", target: "Rex" }]);
  });

  it("fast-paths anaphoric close ('close them' / 'tutup mereka' / 'tutup yang tadi') → lastMentioned", () => {
    const lastMentioned = [{ action: "close", target: { kind: "lastMentioned" } }];
    for (const t of ["close them", "close those", "close it", "tutup mereka", "tutup itu", "tutup yang tadi", "hapus mereka"]) {
      expect(match(t)).toEqual(lastMentioned);
    }
    // A named close is unaffected — "them" only matches as the WHOLE target.
    expect(match("close the item list")).toEqual([{ action: "close", target: "the item list" }]);
  });

  it("tolerates a trailing sentence terminator on commands (dictation / natural phrasing)", () => {
    // Regression: "Close all." fell through close_all (anchored on `all$`) → single close of a node
    // literally named "all." → "No node named 'all.'". The trailing period must not break the match.
    expect(match("Close all.")).toEqual([{ action: "close_all" }]);
    expect(match("arrange the canvas.")).toEqual([{ action: "arrange" }]);
    expect(match("close Rex!")).toEqual([{ action: "close", target: "Rex" }]);
    expect(match("focus Skye.")).toEqual([{ action: "focus", target: "Skye" }]);
    expect(match("open 3 claude agents.")).toEqual([
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
    ]);
  });

  it("keeps trailing '?' on a verbatim dispatch (question to an agent) — not stripped as punctuation", () => {
    const withAgents = { ...ctx, agentNames: ["Rowan"] };
    expect(matchLocalIntent("Rowan, what's your favorite color?", withAgents)).toEqual([
      { action: "dispatch", target: "Rowan", task: "what's your favorite color?" },
    ]);
  });

  it("matches run_task with single/team mode", () => {
    expect(match("run task Fix auth bug")).toEqual([{ action: "run_task", target: "Fix auth bug", mode: "single" }]);
    expect(match("run task Build LP with the team")).toEqual([{ action: "run_task", target: "Build LP", mode: "team" }]);
  });

  it("bails to the LLM (null) for compound, content-bearing, or unknown requests", () => {
    expect(match("create a terminal and a note")).toBeNull(); // compound
    expect(match("focus Skye and close Rex")).toBeNull(); // compound
    expect(match("close Rex dan focus Skye")).toBeNull(); // compound (Indonesian "dan")
    expect(match("buat terminal dan sebuah note")).toBeNull(); // compound (Indonesian "dan")
    expect(match("create a note that says hello")).toBeNull(); // content-bearing
    expect(match("spawn a claude agent to build the hero")).toBeNull(); // briefed spawn
    expect(match("do something clever")).toBeNull(); // unrecognized
    expect(match("")).toBeNull();
  });

  it("switches project by name only with an explicit project keyword (EN + ID)", () => {
    expect(match("switch to project Beta")).toEqual([{ action: "switch_project", target: "Beta" }]);
    expect(match("pindah ke proyek Alpha")).toEqual([{ action: "switch_project", target: "Alpha" }]);
    expect(match("ganti ke project Lotus")).toEqual([{ action: "switch_project", target: "Lotus" }]);
    expect(match("open project orbit")).toEqual([{ action: "switch_project", target: "orbit" }]);
    expect(match("go to project my app")).toEqual([{ action: "switch_project", target: "my app" }]);
  });

  it("switches to the previous project via a back-reference (EN + ID), no project name needed", () => {
    expect(match("switch to the previous project")).toEqual([{ action: "switch_project", target: "previous" }]);
    expect(match("go back to the last project")).toEqual([{ action: "switch_project", target: "previous" }]);
    expect(match("previous project")).toEqual([{ action: "switch_project", target: "previous" }]);
    expect(match("proyek sebelumnya")).toEqual([{ action: "switch_project", target: "previous" }]);
    expect(match("balik ke proyek tadi")).toEqual([{ action: "switch_project", target: "previous" }]);
    expect(match("kembali ke proyek sebelumnya")).toEqual([{ action: "switch_project", target: "previous" }]);
  });

  it("does NOT treat a plain 'open <site>' or 'go to <name>' as a project switch", () => {
    // No project keyword → must not be stolen from open_browser / focus.
    expect(match("open youtube.com")).toEqual([{ action: "open_browser", url: "youtube.com" }]);
    expect(match("go to Skye")).toEqual([{ action: "focus", target: "Skye" }]);
  });

  it("opens app pages (settings / canvases) EN + ID", () => {
    expect(match("open settings")).toEqual([{ action: "open_page", page: "settings" }]);
    expect(match("buka pengaturan")).toEqual([{ action: "open_page", page: "settings" }]);
    expect(match("browse canvases")).toEqual([{ action: "open_page", page: "canvases" }]);
    expect(match("buka proyek")).toEqual([{ action: "open_page", page: "canvases" }]);
  });

  it("creates a new project (EN + ID), distinct from switching/opening one", () => {
    expect(match("new project")).toEqual([{ action: "new_project" }]);
    expect(match("create a new project")).toEqual([{ action: "new_project" }]);
    expect(match("buat proyek baru")).toEqual([{ action: "new_project" }]);
  });

  it("closes the current project or a named one, without stealing close_all's 'canvas'", () => {
    expect(match("close this project")).toEqual([{ action: "close_project" }]);
    expect(match("tutup proyek ini")).toEqual([{ action: "close_project" }]);
    expect(match("close project Beta")).toEqual([{ action: "close_project", target: "Beta" }]);
    // "clear the canvas" / "close the canvas" stays close_all — NOT close_project.
    expect(match("clear the canvas")).toEqual([{ action: "close_all" }]);
    expect(match("close the canvas")).toEqual([{ action: "close_all" }]);
  });
});

// Bilingual parity: the close/spawn/create/project matchers already accept Indonesian, but focus /
// arrange / recover / make_lead / run_task were English-only — so an Indonesian speaker's simple
// command fell through to the (slow) LLM planner. These bring EN + ID to parity (still 0-token).
describe("matchLocalIntent — Indonesian parity for focus/arrange/recover/make_lead/run_task", () => {
  it("focuses a node with Indonesian verbs (fokus ke / pilih / pergi ke)", () => {
    expect(match("fokus ke Skye")).toEqual([{ action: "focus", target: "Skye" }]);
    expect(match("fokus Skye")).toEqual([{ action: "focus", target: "Skye" }]);
    expect(match("pilih Rex")).toEqual([{ action: "focus", target: "Rex" }]);
    expect(match("pergi ke Terminal 1")).toEqual([{ action: "focus", target: "Terminal 1" }]);
    // A leading collective quantifier is not a single-node focus → still bails to the LLM.
    expect(match("fokus ke semua")).toBeNull();
  });

  it("arranges the canvas with Indonesian verbs (rapikan / atur / bereskan)", () => {
    for (const t of ["rapikan", "rapikan kanvas", "rapihkan", "atur kanvas", "bereskan kanvas", "tata kanvas"]) {
      expect(match(t)).toEqual([{ action: "arrange" }]);
    }
  });

  it("recovers a node with Indonesian verbs (pulihkan / sambung ulang / mulai ulang)", () => {
    expect(match("pulihkan Skye")).toEqual([{ action: "recover", target: "Skye" }]);
    expect(match("sambung ulang Terminal 1")).toEqual([{ action: "recover", target: "Terminal 1" }]);
    expect(match("sambungkan ulang Rex")).toEqual([{ action: "recover", target: "Rex" }]);
    expect(match("mulai ulang Skye")).toEqual([{ action: "recover", target: "Skye" }]);
  });

  it("promotes a lead with Indonesian verbs (jadikan X lead / pemimpin)", () => {
    expect(match("jadikan Skye lead")).toEqual([{ action: "make_lead", target: "Skye" }]);
    expect(match("jadikan Rex pemimpin")).toEqual([{ action: "make_lead", target: "Rex" }]);
    expect(match("jadikan Skye sebagai lead")).toEqual([{ action: "make_lead", target: "Skye" }]);
    expect(match("angkat Nova jadi ketua")).toEqual([{ action: "make_lead", target: "Nova" }]);
  });

  it("runs a task with Indonesian verbs (jalankan task/tugas X, single + team)", () => {
    expect(match("jalankan task Fix auth bug")).toEqual([{ action: "run_task", target: "Fix auth bug", mode: "single" }]);
    expect(match("jalankan tugas Build LP")).toEqual([{ action: "run_task", target: "Build LP", mode: "single" }]);
    expect(match("jalankan tugas Build LP dengan tim")).toEqual([{ action: "run_task", target: "Build LP", mode: "team" }]);
  });
});

// A compound made ENTIRELY of spawn clauses ("open claude and cursor agents") is safe to resolve
// locally — it just concatenates spawn intents. The generic "and"/"dan" guard used to force these to
// the (slow) planner (real captured miss: "open claude and cursor agents" → HTTP 429 → 3.6s cold CLI).
describe("matchLocalIntent — compound multi-runner spawn (0-token)", () => {
  const claude = { action: "spawn_agent", runner: "claude" };
  const cursor = { action: "spawn_agent", runner: "cursor" };
  const codex = { action: "spawn_agent", runner: "codex" };

  it("resolves a mixed-runner spawn compound locally (the captured miss)", () => {
    expect(match("open claude and cursor agents")).toEqual([claude, cursor]);
  });

  it("resolves counts per clause across the conjunction (EN + ID)", () => {
    expect(match("open 3 claude and 1 codex")).toEqual([claude, claude, claude, codex]);
    expect(match("buka 2 claude dan 1 cursor")).toEqual([claude, claude, cursor]);
    expect(match("spawn 2 claude and a cursor")).toEqual([claude, claude, cursor]);
  });

  it("carries a per-clause model", () => {
    expect(match("open 2 claude opus and 1 codex")).toEqual([
      { action: "spawn_agent", runner: "claude", model: "opus" },
      { action: "spawn_agent", runner: "claude", model: "opus" },
      codex,
    ]);
  });

  it("bails to the LLM when any clause is not a spawn (mixed compound), preserving accuracy", () => {
    expect(match("open claude and close Rex")).toBeNull();
    expect(match("create a terminal and a note")).toBeNull();
    expect(match("focus Skye and close Rex")).toBeNull();
    // No strong signal (bare runner names) stays with the planner — conservative.
    expect(match("claude and codex")).toBeNull();
    // The aggregate count, not only each individual clause, stays inside the circuit breaker.
    expect(match("open 50 claude and 1 codex")).toBeNull();
  });
});
