import '../../models/bootstrap.dart';
import 'widgets/spawn_controls.dart';

/// Everything a spawn from this phone fixes for the life of the cell: the runner, and —
/// when the host offered them — the model, how hard it thinks, and whether it asks.
///
/// One value rather than four loose arguments, because the four travel together through
/// the sheet, the composer, the biometric gate and the starting screen, and a spawn
/// that carried a model for one runner and a posture chosen for another is the bug a
/// bag of arguments cannot prevent.
///
/// **Absent means the CLI's default** for [effort] alone, whose own scale begins at `auto` —
/// a value that genuinely means *do not send one*.
///
/// [model] and [posture] are named on every spawn, resting or not, and both learned it the
/// hard way. A sheet that highlights `sonnet` and sends nothing is a lie the moment any config
/// layer disagrees, and one did: `~/.claude/settings.json` said `opus[1m]`, so the operator
/// chose sonnet on the phone and watched an opus cell spawn (2026-08-27). No marker the host
/// can send would fix that — the real default is layered across managed, user, project and env
/// settings. What is traded away is a machine default that moves later; what is bought is that
/// the sheet's answer is the cell's answer.
class SpawnChoice {
  const SpawnChoice({
    required this.runner,
    this.model,
    this.effort,
    this.posture,
    this.profile,
    this.terminal = true,
  });

  /// The resting choice for a runner: default model, default effort, and the stop the host
  /// marked as this runner's resting one.
  ///
  /// For the Claude family that stop is `manual`, and it is not a shrug — a gated cell asks
  /// by raising `needs-input`, and the phone is the thing standing by to answer.
  SpawnChoice.resting(this.runner)
      : model = runner.restingModel,
        effort = null,
        profile = null,
        // **Where this runner's conversation actually is.** A runner with no terminal has
        // only one path; and a runner whose terminal cell has no Chat page — codex — rests
        // on its bridge whenever it has one, because resting it on the terminal rests it on
        // a dead end. Reported twice from a real device on 2026-09-08: the operator meant
        // Chat and got a terminal cell, the alternative being one tap below *Start*.
        posture = runner.restingPermission(headless: !_restsInTerminal(runner))?.id,
        terminal = _restsInTerminal(runner);

  final SpawnRunner runner;

  /// Whether this runner's resting path is a terminal: **only when there is no bridge to
  /// rest on instead.**
  ///
  /// Decided 2026-09-08, closing the open question `plans/provider-bridge-adoption/PLAN.md`
  /// §6.1 left for the product owner. The rule used to prefer the terminal wherever a
  /// terminal cell had a Chat page at all ([SpawnRunner.chatInTerminal]) — true for Claude —
  /// and that sentence hid what "at all" was buying. A Claude terminal cell's Chat is
  /// assembled from hooks and the CLI's own transcript file, which means **no streaming
  /// text** (`conversation/runner-caps.ts` says `streaming: never` for that lane in as many
  /// words) and a permission card built by scraping the terminal — a parse that fails closed
  /// on any prompt drawn inside a box, and that the phone then draws as *"This agent is
  /// waiting, but its options could not be read."* The bridge has both for real: streamed
  /// prose, and an approval the runner genuinely waits on.
  ///
  /// So the preference is now the plain one: **if this host can run it without a terminal,
  /// that is where its conversation is.** No runner is named here, which is the point — the
  /// last version of this rule that guessed from a runner's id had to be taken out
  /// (Fase 2.5), and a rule that reads a capability the host advertises stays right when the
  /// next bridge lands.
  ///
  /// The terminal is not taken away: it is the RUNS IN row above *Start* (a line under it
  /// until 2026-11-20), and it stays the resting choice for every runner with no bridge.
  static bool _restsInTerminal(SpawnRunner runner) => runner.terminal && !runner.headless;

  /// A model id the host advertised (`sonnet`, `gpt-5.4-codex`), or null for the default.
  final String? model;

  /// A value from the runner's own scale, or null for the default.
  final String? effort;

  /// A stop id from the runner's own scale (`manual`, `acceptEdits`, `read-only`), or null
  /// for a runner that advertised none — then no field is sent and the machine keeps its own
  /// default, rather than this phone claiming a posture it cannot hold.
  ///
  /// **Unlike [model] and [effort], the resting choice is sent rather than omitted.** Those
  /// two rest on *absent* so a machine default that moves later is still honoured. This one
  /// cannot: absence already means something here, and it does not mean the same thing on
  /// both spawn paths — a PTY spawn that carries no mode is launched ungated
  /// (`resolveRunnerCommand` defaults to `full`), while a headless one asks. Naming the stop
  /// every time is what makes the sheet's answer the cell's answer, on the one choice that
  /// cannot be changed after it is made (ADR-8).
  final String? posture;

  /// Whether the cell gets a terminal. True is what every host has always done; false is
  /// the operator's explicit choice on a runner the host can run headless
  /// ([SpawnRunner.headless]) — Chat only, approvals answered from the phone.
  final bool terminal;

  /// An account id from [SpawnRunner.profiles], or null for the one the machine itself has
  /// chosen — then nothing is sent (`plans/portable-accounts/issues/07`).
  final String? profile;

  /// What the operator reads for the account: the host's label, never the id.
  String? get profileLabel {
    final id = profile;
    if (id == null) return null;
    for (final p in runner.profiles) {
      if (p.id == id) return p.label;
    }
    return id;
  }

  /// The same choice, re-read against the host's **current** description of this runner.
  ///
  /// Exists because a choice outlives the snapshot it was made from. A [SpawnChoice]
  /// carries its [SpawnRunner] whole — models, efforts, gate — and the composer holds one
  /// for as long as that id keeps appearing in the host's list. So a runner whose catalog
  /// moved on the machine (a codex cache refreshed, an alias added, a custom runner that
  /// gained a picker) went on drawing the list it had at the moment it was chosen, until
  /// the app was killed. Re-binding on every read is what makes the sheet say what the
  /// machine says *now*.
  ///
  /// **Tuning the new catalog no longer offers is dropped, not carried.** A model id the
  /// host stopped advertising would still have ridden along on *Start*, and the CLI is
  /// what would then refuse it — far from the operator who chose it. Falling back to the
  /// runner's own default is the one answer that always spawns.
  SpawnChoice rebound(SpawnRunner fresh) {
    if (fresh.id != runner.id) return SpawnChoice.resting(fresh);
    if (identical(fresh, runner)) return this;
    return SpawnChoice(
      runner: fresh,
      model: fresh.models.any((m) => m.id == model) ? model : fresh.restingModel,
      effort: fresh.efforts.contains(effort) ? effort : null,
      // A stop the new catalog no longer offers is dropped rather than carried, exactly as a
      // model is: the CLI would be what refused it, far from the operator who chose it.
      posture: fresh.permissions.any((p) => p.id == posture)
          ? posture
          : fresh.restingPermission(headless: !terminal)?.id,
      // An account the machine no longer has would be refused by name; the machine's own choice always spawns.
      profile: fresh.profiles.any((p) => p.id == profile) ? profile : null,
      // A host that stopped offering headless gets a terminal back; a choice it cannot
      // honour must not ride along to `POST /m/cells`. A runner that *has* no terminal
      // stays on Chat however the choice was made.
      terminal: !fresh.terminal ? false : (fresh.headless ? terminal : true),
    );
  }

  SpawnChoice copyWith({
    Object? model = _keep,
    Object? effort = _keep,
    Object? posture = _keep,
    Object? profile = _keep,
    bool? terminal,
  }) =>
      SpawnChoice(
        runner: runner,
        model: identical(model, _keep) ? this.model : model as String?,
        effort: identical(effort, _keep) ? this.effort : effort as String?,
        posture: identical(posture, _keep) ? this.posture : posture as String?,
        profile: identical(profile, _keep) ? this.profile : profile as String?,
        // A runner with no terminal cannot be given one, whoever asks. The sheet does not
        // offer the toggle for it; this is what keeps a stale choice from carrying one
        // anyway, to a spawn the host would refuse.
        terminal: runner.terminal ? (terminal ?? this.terminal) : false,
      );

  /// `false` on the wire only when the operator chose no terminal; null otherwise.
  bool? get tui => terminal ? null : false;

  /// What the operator reads for the posture: the host's own word, never the id.
  String? get postureLabel {
    final id = posture;
    if (id == null) return null;
    for (final p in runner.permissions) {
      if (p.id == id) return p.label;
    }
    return id;
  }

  /// Whether the posture sits where this runner rests, for the terminal it will be born with.
  /// What decides whether the chip prints it: a resting posture is not news.
  bool get postureIsResting =>
      posture == runner.restingPermission(headless: !terminal)?.id;

  /// The same question for the model. **Now about the picker, not the wire**: the model is
  /// sent either way, and this only decides whether the chip repeats it.
  bool get modelIsResting => model == runner.restingModel;

  /// What the operator reads for the model: the host's short label, never the id.
  String? get modelLabel {
    final id = model;
    if (id == null) return null;
    for (final m in runner.models) {
      if (m.id == id) return m.label;
    }
    return id;
  }

  /// `claude · sonnet · high` — the runner, then only what was moved off its default.
  /// Printed on the composer chip and the starting screen, because those two are where a
  /// wrong choice can still be caught, and the model is what is easiest to get wrong.
  String get summary => [
        runner.label,
        if (!modelIsResting) ?modelLabel,
        ?effort,
        if (!postureIsResting) ?postureLabel,
        ?profileLabel,
        if (!terminal) 'no terminal',
      ].join(' · ');

  /// The tuning alone (`sonnet · high`), or null when everything rests on its default.
  String? get tuningSummary {
    final parts = [
      if (!modelIsResting) ?modelLabel,
      ?effort,
      if (!postureIsResting) ?postureLabel,
      ?profileLabel,
      if (!terminal) 'no terminal',
    ];
    return parts.isEmpty ? null : parts.join(' · ');
  }
}

const Object _keep = Object();

/// [RunnerModel] re-exported for the sheet, so `features/` reads one import.
typedef SpawnModel = RunnerModel;
