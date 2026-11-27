import type { HostMode } from "./events.js";

/**
 * What this façade advertises, and why each capability is where it is.
 * Split from `events.ts`; every name is re-exported from there.
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
    // Starting and ending a cell: both modes serve `/api/fleet/spawn` and `/close`
    // (`routes/fleet-lifecycle.ts` on a standalone host). Not in `DESKTOP_ONLY_FEATURES`,
    // because client mode is BASE + DESKTOP_ONLY.
  "spawn",
  "close",
  /**
   * `runners[].models`/`efforts` on `/m/bootstrap`, `model`/`effort` on `POST /m/cells`
   * (`plans/pocket-without-laptop/issues/24`). The flag comes last: advertising a picker
   * before the spawn route honours it would be silently ignored, as with `spawn` below.
   */
  "spawn-tuning",
] as const;

/**
 * What only a desktop-backed host can do: `transcript`/`permission` (TUI cells, Rust-side
 * watcher; see `STRUCTURED_FEATURES`), `stt` (ADR-11), `conversation` (rides on `transcript`),
 * `pty-size` (ADR-6 addendum; lease in `pty/size_lease.rs`).
 */
const DESKTOP_ONLY_FEATURES = ["transcript", "permission", "stt", "conversation", "pty-size"] as const;

/**
 * `close` and `spawn` left this list only after the permission hazard was closed
 * (`server/agent/gating.ts`): advertising them earlier would show a posture the machine
 * ignored, on a cell ADR-8 says cannot be turned back. The flag comes last.
 */

/**
 * The three of those a standalone host reclaims once it runs Codex itself:
 * `cell-routes.ts` consults `deps.structured` before the desktop fallback. `stt` is NOT here:
 * it needs a key store (ADR-11).
 */
const STRUCTURED_FEATURES = ["permission", "transcript", "conversation", "conversation-stream"] as const;

/**
 * What an installed agent hook buys for **TUI** cells: the same three as
 * `STRUCTURED_FEATURES`, since the hook alone says a turn happened and where the history is.
 */
const HOOK_FEATURES = ["permission", "transcript", "conversation", "conversation-stream"] as const;

/**
 * Every capability this façade advertises, from ONE function so `hello` and `POST /m/pair`
 * cannot drift apart (ADR-10 makes `hello.hostCaps` authoritative).
 * A hint about shape, not a promise per cell: per-call `hostSupports` stays authoritative.
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
  // A TUI cell can be asked about only where a hook is installed: the terminal cannot tell a
  // live prompt from an old one (ADR-8). `transcript` and `conversation` come with it, since
  // the hook names the runner's own transcript file (`transcript_path`). Still a hint: a codex
  // TUI cell answers `hostSupports: false`.
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
   * Whether this host has a workspace root to clone into — `POST /m/projects/clone`
   * (`plans/pocket-vps-project-checkout`). The flag comes after the route works, or the phone
   * would draw an *Add project* door the machine answers 503 to.
   */
  projectsCreate?: boolean;
  /**
   * Whether this host opens directories for browsing and takes one as a project —
   * `GET /m/fs`, `POST /m/projects` (`plans/pocket-vps-project-checkout`). Browsing without
   * taking is a dead end, so the two share a flag.
   */
  projectsBrowse?: boolean;
  /**
   * Whether `POST /m/cells` accepts `tui: false` — a Codex agent run over `codex app-server`
   * (`plans/pocket-chat-conversation-model`). Independent of mode; off when the binary is absent.
   */
  structuredSpawn?: boolean;
  /**
   * Whether an agent hook is installed and reporting turns to this host (slice 1b).
   *
   * What it buys is `permission` for TUI cells, and nothing else — see the note at the call site.
   */
  hooks?: boolean;
}
