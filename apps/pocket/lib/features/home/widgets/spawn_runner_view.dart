import 'spawn_controls.dart';

/// Index arithmetic for the summon sheet's pickers, kept out of the widget so it can be read
/// without the layout around it. Index 0 of the effort scale is `auto`.
///
/// Its own file since 2026-08-27: `summon_step.dart` crossed the 300-line limit when the
/// permission track arrived, and this was already the part of it that had nothing to do with
/// layout.
class SpawnRunnerView {
  const SpawnRunnerView(this.runner);

  final SpawnRunner runner;

  /// The chosen model's index, or the host's default when nothing was chosen.
  int modelIndex(String? id) {
    final models = runner.models;
    final want = id ?? _defaultModelId;
    final i = models.indexWhere((m) => m.id == want);
    return i < 0 ? 0 : i;
  }

  /// The id to store for a tap on [i] — **always the id, even for the host's default**.
  ///
  /// It used to answer null there, so the request carried no `model` and whatever the CLI
  /// defaulted to was honoured. That is the right rule for a default nobody can see, and the
  /// wrong one for a highlighted segment: measured 2026-08-27, the host advertises `sonnet` as
  /// Claude's default while the operator's own `~/.claude/settings.json` said `opus[1m]`. So
  /// the sheet showed **sonnet** selected, sent nothing, and an opus cell was born.
  ///
  /// A picker whose highlighted choice does nothing is a lie, and no marker the host can send
  /// will fix it — the real default is layered across managed settings, user settings, project
  /// settings and env. Naming the choice every time is the only answer that holds whatever
  /// those layers say. Same reasoning as [SpawnChoice.posture], and the same trade accepted:
  /// a machine default that moves later no longer reaches a phone spawn.
  String? modelAt(int i) => runner.models[i].id;

  /// The id the knob rests on: what the host marked, or the first alias when it marked none.
  String? get defaultModelId {
    for (final m in runner.models) {
      if (m.isDefault) return m.id;
    }
    return runner.models.isEmpty ? null : runner.models.first.id;
  }

  String? get _defaultModelId => defaultModelId;

  int effortIndex(String? effort) => effort == null ? 0 : runner.efforts.indexOf(effort) + 1;

  String? effortAt(int i) => i == 0 ? null : runner.efforts[i - 1];
}
