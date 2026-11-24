import 'runner_tuning.dart';

/// One agent runner a host can launch — a detected CLI, or one the operator defined.
///
/// **The phone used to hardcode three names, and a hardcoded list is wrong in both
/// directions.** Measured against a real machine on 2026-08-09 it offered `gemini`,
/// which was not installed, and it could not offer `Pi` or `acme`, which were —
/// because a custom runner is a name and a command the operator invented, and nothing
/// but that machine's registry knows it exists.
///
/// Native and custom arrive as one list on purpose: to a screen that only wants to
/// start something, "found on PATH" and "you wrote this yourself" is not a difference
/// it can act on. What it can act on is [gates].
class HostRunner {
  const HostRunner({
    required this.id,
    required this.name,
    required this.gates,
    this.models = const [],
    this.efforts = const [],
    this.permissions = const [],
    this.headless = false,
    this.terminal = true,
    this.chatInTerminal = true,
    this.profiles = const [],
  });

  /// What a spawn names — `claude`, or `custom-acme`.
  final String id;

  /// What the operator calls it: `Pi`, `acme`. Never the command; a command is a
  /// thing to run, not a thing to show someone at arm's length.
  final String name;

  /// Whether this runner has a permission gate that can be asked for at spawn — which
  /// is to say, whether it runs the `claude` binary so Lotus' hooks fire for it. False
  /// means a cell born from it can never ask, so no posture is claimed on its behalf.
  final bool gates;

  /// What `--model` may be set to when this runner is started from here — aliases
  /// the CLI resolves itself, so the list cannot go stale between releases.
  ///
  /// **Empty means the phone offers no picker**, and the ways to get there must not be
  /// told apart: a host older than `spawn-tuning`, a runner whose flags Lotus does not
  /// know (`cursor`, `Opencode`), and a runner whose own command already fixes a model.
  /// One rule for all of them: draw the control only when there is something to choose
  /// from. Note what is *not* on that list — a custom runner. One that runs `claude`
  /// under another account carries the full picker, because the machine appends the flag
  /// for it (`spawn-tuning.ts`, `pinsTuning`).
  final List<RunnerModel> models;

  /// The values this runner's effort knob accepts, lowest first. Per runner because
  /// the scales genuinely differ — Codex has `xhigh`, Claude has `max` — and a slider
  /// with the wrong stops would send a value the CLI rejects. Empty: no slider.
  final List<String> efforts;

  /// The stops this runner's permission scale offers, least free first.
  ///
  /// Empty means **do not offer the control** — an older host, or a runner whose flags Lotus
  /// does not know (`cursor`, `gemini`). Offering one there would be a brake with nothing on
  /// the other end of it (ADR-14), which is the whole rule `models` and `efforts` follow.
  ///
  /// Per runner because the scales are genuinely different, not differently labelled: Claude
  /// takes `--permission-mode`, Codex has no such flag at all and answers to a sandbox and an
  /// approval policy instead. A scale invented in this app would be wrong for one of them.
  final List<RunnerPermission> permissions;

  /// The accounts this machine is logged into for this runner, `default` being the CLI's own.
  ///
  /// **Empty means offer no picker** — the rule every other tuning field here follows. A host
  /// older than the field, a runner whose accounts Lotus cannot enumerate, and a machine with
  /// a single account all arrive the same way, and a client must not tell them apart: one row
  /// is a decision the operator cannot make.
  ///
  /// One cell runs as one account, chosen at spawn and unchangeable after. Account
  /// *selection*, not pooling — each account's limits stay its own.
  final List<RunnerProfile> profiles;

  /// Whether this host can start this runner with **no terminal**.
  ///
  /// Per runner, not per host. [PairedHost.canRunHeadless] says the host has a structured
  /// path at all; this says which runners it actually reaches. The app used to infer the
  /// second from the first — "the host can, and this is Codex" — which was true only while
  /// Codex was the one structured runner, and became wrong the day Cursor arrived over ACP.
  ///
  /// **Absent reads as false**, the rule every other tuning field here follows: a host that
  /// cannot say must not have the phone guess for it.
  final bool headless;

  /// Whether this runner can be started **with** a terminal.
  ///
  /// True for every runner a host has ever named, and the reason the field defaults that way:
  /// absence means the host is older than it, or the runner has one. `false` is a provider the
  /// machine reaches only through a bridge — `cursor` — which has no PTY runner behind it at
  /// all. Before the host said so, such a runner never reached the phone and Chat could not be
  /// opened on it; saying so is what lets the sheet offer it without offering a terminal that
  /// would fail to start.
  final bool terminal;

  /// Whether a cell of this runner started **with** a terminal has a Chat page at all.
  ///
  /// False is codex: its whole surface into Lotus is one end-of-turn notify, so a terminal
  /// codex cell reads "codex does not report the steps it takes" and always will — while the
  /// same runner over its bridge streams a whole conversation. A limit of the path, not of
  /// the runner, which is why the answer is *rest it on the bridge* rather than *hide it*.
  final bool chatInTerminal;

  /// Whether the summon sheet has anything to tune on this runner at all.
  bool get tunable => models.isNotEmpty || efforts.isNotEmpty;

  /// The model the CLI would pick on its own, or null when the host marked none.
  RunnerModel? get defaultModel {
    for (final m in models) {
      if (m.isDefault) return m;
    }
    return null;
  }

  factory HostRunner.fromJson(Map<String, Object?> json) => HostRunner(
        id: json['id']! as String,
        name: json['name'] as String? ?? json['id']! as String,
        gates: json['claudeFamily'] as bool? ?? false,
        models: RunnerModel.listFromJson(json['models']),
        permissions: RunnerPermission.listFromJson(json['permissions']),
        efforts: switch (json['efforts']) {
          final List<Object?> raw => raw.whereType<String>().toList(growable: false),
          _ => const [],
        },
        headless: json['headless'] as bool? ?? false,
        terminal: json['terminal'] as bool? ?? true,
        chatInTerminal: json['chatInTerminal'] as bool? ?? true,
        profiles: RunnerProfile.listFromJson(json['profiles']),
      );

  /// Absent and empty are the same answer here — *this host named no runners* — and a
  /// client that told them apart would be inventing a distinction the wire does not
  /// carry.
  static List<HostRunner> listFromJson(Object? raw) => raw is! List<Object?>
      ? const []
      : raw
          .whereType<Map<String, Object?>>()
          .map(HostRunner.fromJson)
          .toList(growable: false);
}


/// One account a runner may be started as.
///
/// Same shape as [RunnerModel] and beside it for the same reason: the phone must not carry a
/// table of which accounts exist on which machine.
class RunnerProfile {
  const RunnerProfile({required this.id, required this.label});

  /// What a spawn sends. `default` is the runner's own directory.
  final String id;

  /// What the operator reads — the name they gave the account.
  final String label;

  static List<RunnerProfile> listFromJson(Object? raw) => raw is! List<Object?>
      ? const []
      : raw
          .whereType<Map<String, Object?>>()
          .where((e) => e['id'] is String)
          .map((e) => RunnerProfile(
                id: e['id']! as String,
                label: e['label'] as String? ?? e['id']! as String,
              ))
          .toList(growable: false);
}
