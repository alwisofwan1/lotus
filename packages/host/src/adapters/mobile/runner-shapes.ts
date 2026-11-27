import type { RunnerSummary } from "../../types/runners.js";

/**
 * A runner as `/m/bootstrap` describes it, plus what a phone may tune when it starts one.
 * The added fields are optional on purpose: absence means the phone must not offer that
 * control (`contract/README.md`, Compatibility; Pocket ADR-14).
 */
export interface TunedRunner extends RunnerSummary {
  /**
   * The stops this runner's permission scale offers, least free first. Absent means no such
   * control: an older host, or a runner whose flags Lotus does not know.
   */
  permissions?: RunnerPermission[];
  /**
   * What `--model` may be set to. Aliases, never pinned ids, so the list cannot go stale. The
   * one marked `default` is the resting choice and sends nothing.
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
   * Absent means no picker (same rule as `models`/`efforts`). One cell runs as one account,
   * chosen at spawn; each account's limits stay its own.
   */
  profiles?: RunnerProfile[];

  /**
   * Whether this host can start this runner with **no terminal** — `POST /m/cells {tui:false}`.
   * Per runner: `structured-spawn` in `hostCaps` says only that the host has a structured path.
   * Absent reads as `false`: a host that cannot say must not have the phone guess.
   */
  headless?: boolean;

  /**
   * Whether this runner can be started **with** a terminal. Absent reads as yes.
   * `false` is a provider reached only through a bridge (`cursor`, no PTY runner): the phone
   * must not offer a terminal that would fail to start.
   */
  terminal?: boolean;

  /**
   * Whether a cell started **with** a terminal has a Chat page at all; absent reads as yes.
   * `false` is codex: no transcript read, so its terminal cell never has steps. The phone rests it on its bridge.
   */
  chatInTerminal?: boolean;
}

/** A provider this host can run without a terminal, and what the operator reads for it. */
export interface HeadlessRunner {
  id: string;
  label: string;
}

/**
 * One account a runner may be started as. Same shape as {@link RunnerModel}: the phone must
 * not carry a table of accounts. `default` is the CLI's own config dir.
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
 * One stop on a runner's permission scale, as `/m/bootstrap` advertises it. Same shape as
 * {@link RunnerModel}: the phone carries no table of what each CLI accepts. Absent means no
 * scale, so no control (Pocket ADR-14).
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
   * The resting stop when the runner is spawned with no terminal (`tui: false`). Codex's paths
   * disagree: PTY is `--dangerously-bypass-approvals-and-sandbox`, structured is `on-request`
   * and can route approvals to the phone. Omitted where the two agree.
   */
  defaultHeadless?: boolean;
}
