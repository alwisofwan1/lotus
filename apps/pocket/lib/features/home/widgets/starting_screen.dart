import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../shared/runner_mark.dart';
import '../../shared/tilde_path.dart';

/// The seconds between *the machine took it* and *the cell is on Home*.
///
/// Nothing filled that gap before: the composer sent a spawn, said so in a snackbar, and the
/// agent appeared whenever the next fleet snapshot happened to arrive. On a tailnet that is a
/// few seconds of a screen that looks exactly like a screen where nothing was asked for.
///
/// **It exists for the fact the operator cannot check anywhere else: where.** A phone can
/// send an agent into the wrong repository, and that is the risk `R-10` is written against —
/// so the path and the machine are the largest quiet thing here, stated at the one moment
/// they can still be acted on.
///
/// **The mockup drew `Cancel`, and there is nothing to cancel.** `SpawnedCell.paneId` is
/// optional by design — its own doc says a 200 *"says the machine took it, and that is the
/// whole answer the phone acts on"* — so on a host that answered `{}` there is no pane to
/// end. And even where there is one, ending it is not cancelling: the process started, and it
/// may already have written something. So this screen offers what is true, which is leaving
/// it to start. Ending the agent is a left swipe on Home, one screen away, seconds later.
///
/// `BACK` rather than a new word: `agent_screen.dart` already uses it for exactly this act,
/// and a second word for leaving a surface is how two screens start to disagree.
class StartingScreen extends StatelessWidget {
  const StartingScreen({
    required this.runner,
    required this.path,
    required this.machine,
    required this.onDismiss,
    this.tuning,
    super.key,
  });

  /// What the host will launch — `claude`, `codex`, or the operator's own runner id. Drives
  /// both the name and the mark, so an unrecognised runner still names itself.
  final String runner;

  /// Where the agent is being made. The one fact this screen exists to state.
  final String path;

  /// The machine, **already qualified**: empty when one host is paired and it would
  /// distinguish nothing (`hostQualifier`, the rule three other screens already follow).
  final String machine;

  /// Stops watching. Does not stop the agent — see the class doc.
  final VoidCallback onDismiss;

  /// `sonnet · high` — what was moved off the runner's defaults, or null when nothing
  /// was. Printed here because this is the last screen where a wrong model can still be
  /// caught before the cell has done anything with it.
  final String? tuning;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // The same asset the list and the picker draw, at the size this screen
                    // can afford. Never [AppTokens.waiting]: amber means an agent is waiting
                    // on the operator, and starting is not that.
                    RunnerMarkGlyph(agentType: runner, color: t.dim, size: 34),
                    const SizedBox(height: 14),
                    Text(
                      runner,
                      style: t.serif.copyWith(
                        fontSize: 26,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -0.4,
                        color: t.text,
                      ),
                    ),
                    const SizedBox(height: 9),
                    Text(
                      'STARTING',
                      style: t.mono.copyWith(
                        fontSize: 10.5,
                        letterSpacing: 0.18 * 10.5,
                        color: t.muted,
                      ),
                    ),
                    if (tuning case final tuning?) ...[
                      const SizedBox(height: 10),
                      Text(
                        tuning,
                        style: t.serif.copyWith(fontSize: 15, color: t.dim),
                      ),
                    ],
                    const SizedBox(height: 22),
                    Text(
                      _where,
                      textAlign: TextAlign.center,
                      style: t.mono.copyWith(fontSize: 11.5, color: t.muted),
                    ),
                  ],
                ),
              ),
            ),
            TextButton(
              onPressed: onDismiss,
              child: Text(
                'BACK',
                style: t.mono.copyWith(
                  fontSize: 10.5,
                  letterSpacing: 0.16 * 10.5,
                  color: t.dim,
                ),
              ),
            ),
            const SizedBox(height: 14),
          ],
        ),
      ),
    );
  }

  /// `~/code/cnvs on air`, or just the path where the machine distinguishes nothing.
  ///
  /// Joined here rather than by two `Text`s so the pair wraps as one sentence: on a narrow
  /// phone a path and its machine on separate lines read as two unrelated facts.
  String get _where {
    final shown = tildePath(path);
    return machine.isEmpty ? shown : '$shown on $machine';
  }
}
