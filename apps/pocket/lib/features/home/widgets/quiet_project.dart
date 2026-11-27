import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../composer_mode.dart';
import '../home_summary.dart';
import '../project_presentation.dart';
import '../../shared/refreshable.dart';
import 'project_header.dart';

/// A project that exists with nothing running in it.
///
/// Two situations wear this screen, and they are the same fact arriving from two
/// directions: a dormant project opened from the index, and the project on screen
/// whose last agent just ended. Before ADR-14 neither could be drawn — a project with
/// no cells simply was not a project — and the second one instead moved Home to some
/// other project without a word, changing the title under the operator's thumb.
///
/// **Deliberately not `Nothing here yet.`** That sentence means *the fleet is empty
/// and I cannot say why*, and it offers Diagnostics. This screen is not a fault: the
/// project is real, the host answered, nothing is running. Pointing at Diagnostics
/// here would send the operator to debug a healthy machine.
///
/// **It used to have no way out but the title's caret**, because `/m/*` had no spawn
/// route and a control that cannot be honoured is worse than an empty space. That is
/// the sentence ADR-14 wrote and the condition it named; the condition changed on
/// 2026-08-09. Where the host advertises `spawn`, the composer is here too — already in
/// its new-agent mode, because in a project with nothing running there is exactly one
/// thing worth doing.
///
/// Where it does not, this screen is what it always was. The rule did not move.
class QuietProject extends StatefulWidget {
  const QuietProject({
    required this.project,
    required this.onBack,
    required this.onRefresh,
    this.composer,
    super.key,
  });

  /// Built by the screen, because it needs the repository this widget must not hold
  /// (ADR-13 no. 1). Null on a host that will not start an agent.
  final Widget Function(ComposerMode mode)? composer;

  /// Kembali ke indeks.
  final VoidCallback onBack;

  final ProjectPresentation project;

  /// A dormant project is one of the two places an operator most wants to ask again:
  /// the host said nothing is running here, and the only way to find out whether that
  /// is still true is to ask. The sentence below does not scroll, so this arrives
  /// through [Refreshable.fill].
  final Future<void> Function() onRefresh;

  @override
  State<QuietProject> createState() => _QuietProjectState();
}

class _QuietProjectState extends State<QuietProject> {
  /// Starts *in* the new-agent mode and stays there: there is no agent on this screen
  /// to talk to, so the mode is not a choice here — it is the only meaning the field
  /// can have.
  final ComposerMode _mode = ComposerMode()..startAgent();

  @override
  void dispose() {
    _mode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final composer = widget.composer;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ProjectHeader(
          project: widget.project,
          // No summary line: `HomeSummary` describes agents, and there are none.
          summary: const HomeSummary(waiting: '', rest: ''),
          onBack: widget.onBack,
          onAskAgain: widget.project.isStale ? widget.onRefresh : null,
        ),
        Expanded(
          child: Refreshable.fill(
            onRefresh: widget.onRefresh,
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'No agents are running in this project.',
                      textAlign: TextAlign.center,
                      style: t.ui.copyWith(fontSize: 13.5, color: t.dim),
                    ),
                    if (widget.project.path.isNotEmpty) ...[
                      const SizedBox(height: 14),
                      // The one fact that identifies this project when another shares
                      // its name.
                      Text(
                        widget.project.path,
                        textAlign: TextAlign.center,
                        style: t.mono.copyWith(fontSize: 11.5, color: t.muted),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
        if (composer != null) composer(_mode),
      ],
    );
  }
}
