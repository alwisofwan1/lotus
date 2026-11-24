import type { RunnerSummary } from "../../types/runners.js";

/**
 * A runner as `/m/bootstrap` describes it: what the desktop said, plus what a phone
 * may tune when it starts one.
 *
 * The four added fields are **optional on purpose, and their absence has one
 * meaning: the phone must not offer that control** (`contract/README.md`, Compatibility).
 * A host older than this file sends none of them and the summon sheet ends at the
 * runner name — the same rule `projects[]` follows, and the same reason: a control
 * the machine cannot honour is worse than empty space (Pocket ADR-14).
 */
export interface TunedRunner extends RunnerSummary {
  /**
   * The stops this runner's permission scale offers, least free first. Absent means the
   * phone offers no such control — an older host, or a runner whose flags Lotus does not
   * know (`cursor`, `gemini`), where a posture chosen here would be a brake with nothing
   * on the other end of it.
   */
  permissions?: RunnerPermission[];
  /**
   * What `--model` may be set to. Aliases, never pinned ids: the CLI resolves
   * `sonnet` to the current model of that tier, so the phone's list cannot go stale
   * between releases. The one marked `default` is what the CLI would pick anyway;
   * the phone shows it as the resting choice and sends nothing for it.
   */
  models?: RunnerModel[];
  /**
   * The values the runner's own effort knob accepts, lowest first. Different per
   * CLI — Claude's `--effort` and Codex's `model_reasoning_effort` do not share a
   * scale — which is why the list rides here instead of living in the app.
   */
  efforts?: string[];
  /**
   * The accounts this machine is logged into for this runner, least surprising first.
   *
   * Absent means **the phone offers no picker**, the same rule `models`/`efforts` follow, and
   * the ways to get there must not be told apart: a host older than the field, a runner whose
   * accounts Lotus cannot enumerate, or a machine with only the CLI's own default.
   *
   * One cell runs as one account, chosen at spawn and unchangeable after — which is why this
   * rides beside the other spawn-time knobs rather than being something a cell can be moved
   * between. It is account *selection*: each account's limits stay its own.
   */
  profiles?: RunnerProfile[];

  /**
   * Whether this host can start this runner with **no terminal** — `POST /m/cells {tui:false}`.
   *
   * Per runner, not per host: `structured-spawn` in `hostCaps` says the host has a structured
   * path at all, and this says which runners it actually reaches. Before it existed the phone
   * inferred the answer ("the host can, and this is Codex"), which was true only while Codex
   * was the one bridge — the ACP bridge made that inference wrong for `cursor`.
   *
   * Absent reads as `false`, the same rule the fields above follow: a host that cannot say
   * must not have the phone guess for it.
   */
  headless?: boolean;

  /**
   * Whether this runner can be started **with** a terminal. Absent reads as yes, which is
   * what every host before this field could do and every PTY runner still does.
   *
   * `false` is a provider this machine reaches only through a bridge — `cursor` is the case
   * that made the field necessary. It has no PTY runner, so it never reached
   * `/api/runners`, so the summon sheet never offered it at all and Chat could not be opened
   * on an agent this host could perfectly well run. Advertised now, and advertised honestly:
   * the phone must not offer a terminal that would fail to start.
   */
  terminal?: boolean;

  /**
   * Whether a cell of this runner started **with** a terminal has a Chat page at all.
   * Absent reads as yes.
   *
   * `false` is codex: its whole surface into Lotus is one end-of-turn notify, and no host
   * reads its transcript file, so a terminal codex cell shows *"codex does not report the
   * steps it takes"* and always will. The same runner over its bridge streams a full
   * conversation — so this is not a limit of the runner, it is a limit of the **path**.
   *
   * The phone reads it to pick the resting path: a runner whose terminal cell is a Chat dead
   * end and which has a bridge rests on the bridge. Reported on a real device on 2026-09-08,
   * twice: the operator meant to start codex for Chat and got a terminal cell both times,
   * because the terminal was the resting choice and the alternative was one tap under
   * *Start*. `bb` never has this problem because it has no terminal path for agents at all.
   */
  chatInTerminal?: boolean;
}

/** A provider this host can run without a terminal, and what the operator reads for it. */
export interface HeadlessRunner {
  id: string;
  label: string;
}

/**
 * One account a runner may be started as.
 *
 * Deliberately the same shape as {@link RunnerModel}, for the same reason it sits beside it:
 * the phone must not carry a table of what accounts exist on which machine. `default` is the
 * CLI's own config dir; the rest are whatever the operator named them.
 */
export interface RunnerProfile {
  /** What a spawn sends. `default` is the runner's own directory. */
  id: string;
  /** What the operator reads — the name they gave the account. */
  label: string;
}

export interface RunnerModel {
  /** What a spawn sends: `sonnet`, `gpt-5.4`. */
  id: string;
  /** What the operator reads. Short enough for a four-way segmented control. */
  label: string;
  /** The one the CLI picks on its own. At most one per runner. */
  default?: boolean;
}

/**
 * One stop on a runner's permission scale, as `/m/bootstrap` advertises it.
 *
 * Deliberately the same shape as {@link RunnerModel}, and it sits beside it for the same
 * reason: the phone must not carry a table of what each CLI accepts. Claude takes six values
 * on `--permission-mode` and Codex takes none of them — it has a sandbox axis and an approval
 * axis instead — so a scale invented in the app would be wrong for one of them on the day
 * either CLI moves.
 *
 * **Absent means no scale, which means the phone offers no control at all** — the same rule
 * `models`/`efforts` follow (Pocket ADR-14). A host that cannot honour a posture must not let
 * one be chosen.
 */
export interface RunnerPermission {
  /** What a spawn sends: `manual`, `acceptEdits`, `read-only`. */
  id: string;
  /** What the operator reads, lowercase: `manual`, `accept edits`, `read only`. */
  label: string;
  /**
   * The stop this runner lands on when a spawn carries no mode at all. The phone rests here
   * and **sends nothing**, so a machine default that moves later is still honoured — the
   * rule {@link RunnerModel.default} already states.
   */
  default?: boolean;
  /**
   * The resting stop when the same runner is spawned with no terminal (`tui: false`).
   *
   * Exists because Codex's two paths genuinely disagree and always have: a PTY Codex is
   * launched `--dangerously-bypass-approvals-and-sandbox`, while a structured Codex is
   * started `approvalPolicy: "on-request"` — and that one can route its approvals to the
   * phone, so resting it on *never asks* would throw away the only reason it can ask.
   * Omitted where the two agree, which is every runner but Codex.
   */
  defaultHeadless?: boolean;
}
