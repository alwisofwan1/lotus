import type { HostMode } from "./events.js";

/**
 * What this façade advertises, and why each capability is where it is.
 *
 * Split out of `events.ts` when that file passed 300 lines: the frames on the wire and the
 * vocabulary of what a host can do are two subjects that happened to share a file. Every
 * name is re-exported from `events.ts`, so no caller moved.
 */

const BASE_FEATURES = [
  "fleet",
  "dispatch",
  // Raw key-level writes to a pane's PTY. Base rather than desktop-only: it resolves a
  // session and writes to it, which is the one thing every host mode can already do —
  // `stop` has been doing exactly that, with one hardcoded byte, since the beginning.
  "input",
  "stop",
  "tasks",
  "stream",
  "device-refresh",
  // `refreshKey` on `/m/pair` and `/m/devices/renew*`: a lapsed token comes back with a
  // signature from the phone's hardware key instead of a new pairing code (`renewal.ts`).
  "device-renew",
  // `/m/cell/:id/result` and `/diff`: what differs from HEAD in the pane's directory.
  // Base, not desktop-only — the host runs on the machine that owns `cwd` in both modes,
  // and it is the only source of truth for a runner whose hook ring stays empty.
  "result",
  // Starting and ending a cell. Base since 2026-09-05 (slice 2.4): both modes now serve
  // `/api/fleet/spawn` and `/api/fleet/close` — the desktop through its window, a standalone
  // host through `routes/fleet-lifecycle.ts` against its own `HostedProject`.
  //
  // Moved here rather than deleted from `DESKTOP_ONLY_FEATURES`, and the difference is not
  // cosmetic: `hostFeatures` builds client mode as BASE + DESKTOP_ONLY, so deleting them
  // would have taken both away from the desktop as well. The contract fixtures caught it.
  "spawn",
  "close",
  /**
   * `runners[].models`/`efforts` on `/m/bootstrap`, and `model`/`effort` on `POST /m/cells`.
   *
   * Base since 2026-09-10 (`plans/pocket-without-laptop/issues/24`), and the order it happened
   * in is the whole of it. `tuneRunners()` never depended on mode, so a standalone host was
   * **already** sending the scales; what it could not do was honour them — the TUI spawn route
   * read only `permissionMode` and dropped both one layer short of the argv. Advertising first
   * would have shown the operator a model picker the machine ignored: pick Opus, get the
   * default, and nothing says so. That is the same trap the note below describes for `spawn`,
   * and the flag comes last for the same reason.
   */
  "spawn-tuning",
] as const;

/**
 * What only a desktop-backed host can do, and why each one needs a desktop.
 *
 * - `transcript`, `permission` — for a TUI cell only. The drop-file watcher, the transcript ring
 *   and `pane_turn` live in the desktop's Rust side (PLAN.md §7 no. 10). The older claim here,
 *   that "neither route exists on its API", was already false when written for the `/m/*` façade:
 *   `cell-routes.ts` consults `deps.structured` first, so a host running Codex itself answers
 *   both. See `STRUCTURED_FEATURES` below, which hands them back.
 * - `stt` — the STT provider registry and its API key live in Rust too, and ADR-11
 *   keeps keys off the phone. A VPS host has no key store to transcribe with.
 * - `conversation` — `GET /m/cell/:paneId/conversation`, the transcript as turns of typed
 *   parts with per-runner capabilities (`types/conversation.ts`). Rides on `transcript`,
 *   since it is built from the same desktop read; a separate flag because a phone that
 *   knows the new shape must still draw the old one against a host that predates it.
 * - `pty-size` — `/m/cell/:paneId/size`: the phone holds a pane at its own size while Terminal
 *   is open (ADR-6 addendum 2026-10-05). The lease, and the desktop typing that ends it, live in
 *   the desktop's `pty/size_lease.rs`; a Standalone Host's API has no such route.
 */
const DESKTOP_ONLY_FEATURES = ["transcript", "permission", "stt", "conversation", "pty-size"] as const;

/**
 * `close` and `spawn` left this list on 2026-09-05 (slice 2.4), and the order it happened in
 * is the point.
 *
 * The old entry blamed missing plumbing: `server/app.ts` did not register `/api/fleet/spawn`
 * or `/api/fleet/close`, the routes `ApiClient` calls. That is now fixed
 * (`routes/fleet-lifecycle.ts`) — but it was never the reason to hold the flag. The reason was
 * a hazard in the same comment: `runners/claude.ts` hardcoded `--dangerously-skip-permissions`
 * and `toFleetMember` never set `gating`, so a phone would have been shown a permission posture
 * the machine ignored, on a cell ADR-8 says cannot be turned back once running.
 *
 * Both halves were closed first (slice 2.1, `server/agent/gating.ts`). The flag came last, which
 * is the only order in which it is safe.
 */

/**
 * The three of those a standalone host reclaims once it runs Codex itself.
 *
 * `cell-routes.ts` consults `deps.structured` BEFORE the desktop fallback on both
 * `/transcript` and `/permission`, and `conversation` is built from the same read — so these
 * answer on a VPS with no desktop anywhere. Withholding them was not caution: `paired_host.dart`
 * gates Chat on `hostCaps`, so the phone never called routes the host could already serve.
 *
 * `stt` is deliberately NOT here. It needs a provider key store, and ADR-11 keeps keys off the
 * phone — Codex on PATH does not change that.
 */
const STRUCTURED_FEATURES = ["permission", "transcript", "conversation", "conversation-stream"] as const;

/**
 * What an installed agent hook buys for **TUI** cells.
 *
 * The same three as `STRUCTURED_FEATURES`, arrived at from the other direction: there, this host
 * runs the agent over a protocol and sees everything; here, the agent runs in a terminal and the
 * hook is the only thing that can say a turn happened and where the runner keeps its history.
 */
const HOOK_FEATURES = ["permission", "transcript", "conversation", "conversation-stream"] as const;

/**
 * Every capability this façade advertises. ONE function, because there used to be
 * two lists.
 *
 * A smoke run found `hello` reporting a shorter set than `POST /m/pair`: the
 * routes list had grown and `stream-hub`'s copy had not. Both were unit-tested
 * against their own expectations, so both passed, and a client reading
 * `hello.hostCaps` (which ADR-10 makes the authoritative place) would have hidden
 * features the host actually had.
 *
 * A hint about shape, not a promise per cell: a `client` host whose desktop
 * predates these routes still answers `hostSupports: false`, and that per-call
 * field stays the authoritative answer for a given pane.
 */
export function hostFeatures(mode: HostMode, opts: HostCapabilityOpts = {}): string[] {
  const features: string[] =
    mode === "standalone"
      ? [...BASE_FEATURES]
      : [...BASE_FEATURES, ...DESKTOP_ONLY_FEATURES];

  // Advertised only when this host can actually send — the same discipline `stt`
  // follows (§7 no. 10). Without it the app would register a push token with a host
  // that has no Firebase credentials, then wait for wake-ups that can never arrive:
  // the worst failure mode in this product, because it is silent and looks like
  // nothing is happening.
  if (opts.push === true) features.push("push");
  // A TUI cell can be asked about only where a hook is installed to say so: the terminal alone
  // cannot tell a live prompt from one printed ten minutes ago (ADR-8).
  //
  // `transcript` and `conversation` come with it as of Fase 3 — and the reason they used to be
  // withheld turned out to be the wrong reason. They were expected to be built from the drop
  // file's CONTENTS; they are not. They are read from the runner's **own** transcript file, and
  // the hook is what names it (`transcript_path`, slice 3.1). So the same hook is precisely the
  // precondition for all three.
  //
  // Still a hint about shape, not a promise per cell: a codex TUI cell answers
  // `hostSupports: false`, because this host reads claude's format and not codex's.
  if (opts.hooks === true) {
    for (const feature of HOOK_FEATURES) {
      if (!features.includes(feature)) features.push(feature);
    }
  }
  // A deployment capability, not a mode one. Only a standalone host has a `ProjectCloner`
  // at all, but one configured with a fixed `PROJECTS_JSON` list has nowhere to clone into
  // and would answer 503 to every ask — so the flag follows the workspace root rather than
  // the mode, and the phone draws no door on a machine that cannot open one.
  if (opts.projectsCreate === true) features.push("projects-create");
  // A second flag rather than the same one, because the two ship apart and a host can have
  // one without the other: a machine with `PROJECTS_ROOT` can clone long before its operator
  // names a single `LOTUS_BROWSE_ROOTS` entry. One flag would make the phone draw a folder
  // picker against a host that opens no folders.
  if (opts.projectsBrowse === true) features.push("projects-browse");
  if (opts.structuredSpawn === true) {
    features.push("structured-spawn");
    for (const feature of STRUCTURED_FEATURES) {
      if (!features.includes(feature)) features.push(feature);
    }
  }
  return features;
}

/** Capabilities that depend on deployment, not on mode. */
export interface HostCapabilityOpts {
  /** Whether FCM credentials loaded on this host (ADR-4). */
  push?: boolean;
  /**
   * Whether this host has a workspace root to clone repositories into — `POST
   * /m/projects/clone` (`plans/pocket-vps-project-checkout`).
   *
   * The flag comes last, after the route works, which is the only order in which it is
   * safe: advertised early, the phone would draw an *Add project* door that opens a form
   * the machine answers 503 to, and nothing on screen would say why.
   */
  projectsCreate?: boolean;
  /**
   * Whether this host opens any directory for browsing, and will take one as a project —
   * `GET /m/fs`, `POST /m/projects` (`plans/pocket-vps-project-checkout`).
   *
   * The two go together on purpose: browsing without being able to take is a dead end, and a
   * flag that promised only half of it would send the operator down one.
   */
  projectsBrowse?: boolean;
  /**
   * Whether `POST /m/cells` accepts `tui: false` — a Codex agent this host runs itself over
   * `codex app-server`, with no terminal (Fase 4, `plans/pocket-chat-conversation-model`).
   * Independent of the mode: the host spawns the binary, not the desktop, so a Standalone
   * Host on a VPS with `codex` installed advertises it too. Off when the binary is absent.
   */
  structuredSpawn?: boolean;
  /**
   * Whether an agent hook is installed and reporting turns to this host (slice 1b).
   *
   * What it buys is `permission` for TUI cells, and nothing else — see the note at the call site.
   */
  hooks?: boolean;
}
