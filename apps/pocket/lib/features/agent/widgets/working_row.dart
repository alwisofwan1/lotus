import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/age_label.dart';
import '../../shared/tactile.dart';
import '../work_state.dart';
import 'thinking_orb.dart';

/// What the agent is doing, at the foot of the transcript, while it is doing it.
///
/// Replaces a 5px dot that did not move and a phrase that was usually absent — on a
/// standalone host `lastOutputPreview` is never sent, so the old row drew nothing at
/// all while an agent worked. Four things, each answering a question the operator
/// actually has:
///
/// | | |
/// |---|---|
/// | the orb | is it alive, or stuck? — the only thing on screen that moves |
/// | verb · target | what is it doing? — changes **in place**, so five tools in a row cost one line |
/// | elapsed | how long? — twenty seconds and three minutes must not look alike |
/// | stop | can I end this? — the endpoint has always existed; the button never did |
///
/// Unmounts when the turn closes, which takes the orb's ticker with it: nothing
/// animates on a screen that has gone quiet.
class WorkingRow extends StatefulWidget {
  const WorkingRow({required this.state, this.onStop, this.now, super.key});

  final WorkState state;

  /// Interrupts the turn. Absent for a host that cannot be asked, and the control is
  /// then not drawn — a button that does nothing is worse than no button.
  final VoidCallback? onStop;

  /// Injected so a test can pin the elapsed count.
  final DateTime Function()? now;

  @override
  State<WorkingRow> createState() => _WorkingRowState();
}

class _WorkingRowState extends State<WorkingRow> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // One second, which is the resolution the label has. A faster tick would repaint
    // for a number that did not change.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final state = widget.state;
    final now = (widget.now ?? DateTime.now.call)();
    final elapsed = ageLabel(now.difference(state.startedAt).inMilliseconds.clamp(0, 1 << 40));
    final target = state.target;
    final steps = state.steps;

    return Semantics(
      liveRegion: true,
      label: _spoken(state, elapsed),
      child: ExcludeSemantics(
        child: Container(
          margin: const EdgeInsets.only(top: 6),
          padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
          decoration: BoxDecoration(
            color: t.raise,
            borderRadius: context.shape.radius(ShapeRole.row),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const ThinkingOrb(),
                  const SizedBox(width: 9),
                  Text(state.label, style: t.mono.copyWith(fontSize: 11.5, color: t.dim)),
                  if (target != null) ...[
                    const SizedBox(width: 9),
                    // Ellipsised, never wrapped: one working row stays one row, however
                    // long the command is.
                    Expanded(
                      child: Text(
                        target,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: t.mono.copyWith(fontSize: 11.5, color: t.muted),
                      ),
                    ),
                  ] else
                    const Spacer(),
                  const SizedBox(width: 9),
                  if (elapsed != null)
                    Text(
                      elapsed,
                      style: t.mono.copyWith(
                        fontSize: 11.5,
                        color: t.faint,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                ],
              ),
              if (steps > 0 || widget.onStop != null) ...[
                const SizedBox(height: 9),
                Row(
                  children: [
                    if (steps > 0)
                      Expanded(
                        child: Text(
                          'step $steps of this turn',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: t.mono.copyWith(fontSize: 10.5, color: t.faint),
                        ),
                      )
                    else
                      const Spacer(),
                    if (widget.onStop != null) _stop(t),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _stop(AppTokens t) => InkWell(
        onTap: () {
          Tactile.chose();
          widget.onStop!();
        },
        borderRadius: context.shape.radius(ShapeRole.pill),
        child: Container(
          constraints: const BoxConstraints(minHeight: 28),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            borderRadius: context.shape.radius(ShapeRole.pill),
            border: Border.all(color: t.lineStrong),
          ),
          alignment: Alignment.center,
          child: Text(
            'STOP',
            style: t.mono.copyWith(fontSize: 9.5, letterSpacing: 1.33, color: t.muted),
          ),
        ),
      );

  /// One sentence for a screen reader, because the row's own parts are three fragments
  /// and a turning sphere.
  static String _spoken(WorkState state, String? elapsed) {
    final what = switch (state.phase) {
      WorkPhase.thinking => 'Thinking',
      WorkPhase.writing => 'Writing a reply',
      WorkPhase.tool => 'Running ${state.verb ?? 'a tool'}${state.target == null ? '' : ' on ${state.target}'}',
    };
    return elapsed == null ? what : '$what, $elapsed so far';
  }
}
