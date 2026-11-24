import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../data/dictation.dart';
import '../../../models/host_id.dart';
import '../../../models/cell.dart';
import '../../shared/composer.dart';
import '../composer_mode.dart';
import '../spawn_choice.dart';
import 'composer_chip.dart';
import 'runner_sheet.dart';
import 'spawn_controls.dart';
import 'starting_footer.dart';
import 'target_picker.dart';

/// The composer on Home: one line, and the agent it is aimed at named above it.
///
/// The same [Composer] the Agent page uses — one control, two surfaces, so the send
/// behaviour and the placeholder rules cannot drift apart. What Home adds is the target,
/// because Home is not already inside an agent.
///
/// **The target defaults to the first agent in the list, and that is not an arbitrary
/// pick.** `FleetStore` orders waiting-first (ADR-12 no. 1), so the default is whichever
/// agent needs the operator most — which makes the common case *type and send*, with no
/// tap spent choosing at all. That is what keeps this control worth having: it is now
/// **fewer** taps than opening the agent page, not more.
class HomeComposer extends StatefulWidget {
  const HomeComposer({
    required this.target,
    required this.cells,
    required this.onPickTarget,
    this.onComposing,
    required this.onSend,
    required this.onStartAgent,
    required this.canStartAgent,
    required this.runners,
    required this.projectPath,
    required this.mode,
    this.dictation,
    this.dictateOn,
    required this.enabled,
    super.key,
  });

  /// The agents the picker offers. Passed in rather than fetched: this widget renders a
  /// choice, it does not decide what the choices are.
  final List<Cell> cells;

  /// Starts an agent with what the composer was set to. Answers whether it took, so the
  /// field can hand the brief back when it did not.
  final Future<bool> Function(SpawnChoice choice, String? initialPrompt) onStartAgent;

  /// Whether this project's host will start one at all. False and the picker's last row
  /// is not drawn, so the mode is unreachable rather than disabled.
  final bool canStartAgent;

  /// What this project's host says it can launch — the operator's own runners included.
  /// Empty falls back to what every Lotus machine has ([SpawnRunner.fallback]).
  final List<SpawnRunner> runners;

  /// Printed under the field while starting an agent, because *where* is the one fact
  /// the operator cannot choose here and must be able to check (R-10).
  final String projectPath;

  /// Whether the composer is starting an agent. Shared with the list's last row, which
  /// is the other way into this mode — see [ComposerMode].
  final ComposerMode mode;

  /// The agent this will dispatch to, or **null on a project with no agents** — the
  /// screen that used to be a dead end, where the composer exists only to start one.
  final Cell? target;

  /// Adopts a cell chosen from the picker. The sheet itself is opened here, because
  /// its last row switches this widget's own mode rather than changing anything above.
  final void Function(CellRef ref) onPickTarget;

  /// Diteruskan dari [Composer]: field ini berpindah antara kosong dan berisi.
  final ValueChanged<bool>? onComposing;

  /// Answers whether the words are now accounted for on screen — see [Composer.onSend].
  /// On Home the honest answer is "only if it landed": there is no transcript here to
  /// hold a refused line, so a failed dispatch gives the text back to the field.
  final Future<bool> Function(String text) onSend;

  /// The microphone, aimed at the same agent the chip above names.
  ///
  /// Both are re-read on every build rather than captured once, because the target is a
  /// choice the operator can change between one recording and the next — and changing
  /// it changes which machine turns the audio into words. Null when that host does not
  /// advertise `stt`, which is how a Standalone Host ends up with no microphone at all
  /// (`DESKTOP_ONLY_FEATURES`).
  final Dictation? dictation;
  final HostId? dictateOn;

  /// False while a dispatch is in flight, so one tap cannot become two.
  final bool enabled;

  @override
  State<HomeComposer> createState() => _HomeComposerState();
}

/// Stateful for the choice — runner, model, effort, posture — that exists only while
/// an agent is being made. The *mode* itself is shared (see [ComposerMode]), because
/// the list's last row is the other way into it.
class _HomeComposerState extends State<HomeComposer> {
  bool get _starting => widget.mode.isStartingAgent;

  /// What a new agent would be. Held rather than derived so a choice survives the fleet
  /// snapshots that arrive every few seconds — and re-checked against the host's list on
  /// every build, because a runner deleted in Settings must not stay selected on a
  /// phone that cannot know it went. A runner that vanished takes its tuning with it:
  /// a model chosen for one runner is not a choice about another.
  SpawnChoice? _chosen;

  List<SpawnRunner> get _runners =>
      widget.runners.isEmpty ? SpawnRunner.fallback : widget.runners;

  /// **Re-bound, not just re-validated.** Matching by id kept a choice alive but left it
  /// holding the [SpawnRunner] it was made from — models and efforts included — so a
  /// catalog that moved on the machine reached the store and stopped there: the chip still
  /// printed the old model and the summon sheet still drew the old picker. What is checked
  /// here is the id; what is *used* is the host's current description of it
  /// ([SpawnChoice.rebound]).
  SpawnChoice get _choice {
    final chosen = _chosen;
    if (chosen != null) {
      for (final fresh in _runners) {
        if (fresh.id == chosen.runner.id) return chosen.rebound(fresh);
      }
    }
    return SpawnChoice.resting(_runners.first);
  }

  @override
  void initState() {
    super.initState();
    widget.mode.addListener(_onMode);
  }

  @override
  void didUpdateWidget(HomeComposer old) {
    super.didUpdateWidget(old);
    if (old.mode != widget.mode) {
      old.mode.removeListener(_onMode);
      widget.mode.addListener(_onMode);
    }
    // A project whose host cannot start agents must not leave the composer stuck in a
    // mode it can no longer act on — switching projects is enough to get here.
    if (_starting && !widget.canStartAgent) widget.mode.talkToAgent();
  }

  @override
  void dispose() {
    widget.mode.removeListener(_onMode);
    super.dispose();
  }

  /// Summons already answered, so a rebuild never reopens the sheet.
  int _summonsSeen = 0;

  void _onMode() {
    if (!mounted) return;
    setState(() {});
    if (widget.mode.summons != _summonsSeen) {
      _summonsSeen = widget.mode.summons;
      // After this frame: the composer must be in start mode on screen before the
      // sheet that configures it slides up over it.
      WidgetsBinding.instance.addPostFrameCallback((_) => _chooseRunner());
    }
  }

  /// The runner sheet, opened for the operator rather than waiting for a second tap on
  /// the chip. Dismissed without a choice, the mode stays on with the resting choice —
  /// the chip still opens it again.
  Future<void> _chooseRunner() async {
    if (!mounted || !_starting) return;
    final picked = await showRunnerSheet(
      context,
      runners: _runners,
      projectPath: widget.projectPath,
      current: _choice,
    );
    if (picked != null && mounted) setState(() => _chosen = picked);
  }

  Future<void> _pick() async {
    final choice = await showTargetPicker(
      context,
      cells: widget.cells,
      current: widget.target?.ref,
      canStartAgent: widget.canStartAgent,
    );
    if (choice == null || !mounted) return;
    switch (choice) {
      case SendToCell(:final ref):
        widget.mode.talkToAgent();
        widget.onPickTarget(ref);
      case StartNewAgent():
        widget.mode.summon();
    }
  }

  /// Sends the field's contents wherever the mode points.
  ///
  /// One entry point for both, so the composer's own rules — clear on tap, hand the
  /// words back when nothing took them — cannot end up differing between talking to an
  /// agent and making one.
  Future<bool> _send(String text) async {
    if (!_starting) return widget.onSend(text);
    final brief = text.trim();
    final started = await widget.onStartAgent(_choice, brief.isEmpty ? null : brief);
    // Back to talking. The agent that was just made is the one the operator wants next,
    // and the screen re-aims the composer at it when the snapshot brings it in.
    if (started && mounted) widget.mode.talkToAgent();
    return started;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The chip row exists only while talking: it is the control that changes where the
        // words go. While starting an agent there is nothing to aim at yet, and the row that
        // used to sit here (`+ New agent` beside a runner chip) said the same thing as the
        // list row that opened this mode and as the field's placeholder — three times
        // (removed 2026-08-27). What was chosen is printed under the field instead.
        if (!_starting)
          Container(
            decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
            padding: const EdgeInsets.only(left: 20, right: 20, top: 11),
            child: Row(
              children: [ComposerChip(target: widget.target, starting: false, onTap: _pick)],
            ),
          )
        else
          Container(height: 1, color: t.line),
        Composer(
          // Home has no permission buttons and no terminal, so the only mood that can
          // apply here is the plain one. Reaching for `asking` would promise a third
          // option next to buttons that are not on this screen.
          mood: ComposerMood.working,
          agent: widget.target?.title ?? 'agent',
          // No agent to reply to yet, so the mood's own sentence would be wrong — and
          // saying *optional* is what stops an empty send from looking like a mistake.
          placeholder: _starting ? 'First task, optional' : null,
          enabled: widget.enabled,
          // With no brief it boots and waits, which is a complete instruction.
          allowEmpty: _starting,
          onSend: _send,
          onComposing: widget.onComposing,
          dictation: widget.dictation,
          dictateOn: widget.dictateOn,
        ),
        if (_starting)
          StartingFooter(
            choice: _choice,
            projectPath: widget.projectPath,
            canCancel: widget.cells.isNotEmpty,
            onChoose: _chooseRunner,
            onCancel: widget.mode.talkToAgent,
          ),
      ],
    );
  }

}
