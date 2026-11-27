import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../models/clone_job.dart';
import '../home/widgets/start_button.dart';

/// The seconds between *the machine took it* and *the project is on the index* — and,
/// when it goes wrong, the only place git's own words are ever shown.
///
/// Screens 08 and 09 of `plans/pocket-vps-project-checkout/design/add-project.html`.
/// It borrows `StartingScreen`'s shape because that screen already solved this exact
/// problem, and two of its decisions are inherited rather than re-made:
///
///  - **There is nothing to cancel.** The clone started and may already have written
///    into its staging directory. What is offered is leaving, and the foot says so.
///  - **The largest quiet thing on screen is *where*.** A phone can send work to the
///    wrong machine (R-10), and this is the last moment that is still catchable.
///
/// [onRetry] runs the whole gated mutation again — the caller's job, not this screen's,
/// which holds no repository and can therefore not skip the gate.
class CloneWatch extends StatelessWidget {
  const CloneWatch({
    required this.job,
    required this.machine,
    required this.onDismiss,
    this.onRetry,
    super.key,
  });

  final CloneJob job;

  /// The machine, **already qualified** — empty when naming it distinguishes nothing.
  final String machine;

  /// Stops watching. Does not stop the clone — see the class doc.
  final VoidCallback onDismiss;

  /// Offered only once it has failed: there is nothing to retry while it is working.
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: onDismiss,
                child: Text(
                  'BACK',
                  style: t.mono.copyWith(
                    fontSize: 11,
                    letterSpacing: 0.16 * 11,
                    color: t.muted,
                  ),
                ),
              ),
            ),
            Expanded(child: Center(child: job.isFailed ? _failed(t) : _working(t))),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 22),
              child: Text(
                job.isFailed ? 'NOTHING WAS WRITTEN' : 'LEAVING DOES NOT STOP IT',
                textAlign: TextAlign.center,
                style: t.mono.copyWith(
                  fontSize: 10,
                  letterSpacing: 0.14 * 10,
                  color: t.muted,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _working(AppTokens t) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              job.name,
              textAlign: TextAlign.center,
              style: t.serif.copyWith(
                fontSize: 22,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.4,
                color: t.text,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              job.path,
              textAlign: TextAlign.center,
              style: t.mono.copyWith(fontSize: 12.5, color: t.dim),
            ),
            if (machine.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                machine.toUpperCase(),
                style: t.mono.copyWith(
                  fontSize: 10.5,
                  letterSpacing: 0.14 * 10.5,
                  color: t.faint,
                ),
              ),
            ],
            const SizedBox(height: 26),
            _steps(t),
          ],
        ),
      );

  /// The three steps the host names, with the one it is on lit.
  ///
  /// Green, never amber: a clone asks the operator for nothing, and amber on this screen
  /// means an agent needs you (`MVP.md`).
  Widget _steps(AppTokens t) {
    const order = ['resolving', 'cloning', 'registering'];
    final at = order.indexOf(job.step);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < order.length; i++)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                Container(
                  width: 5,
                  height: 5,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: i == at
                        ? t.live
                        : i < at
                            ? t.muted
                            : t.faint,
                  ),
                ),
                const SizedBox(width: 10),
                Text(
                  order[i].toUpperCase(),
                  style: t.mono.copyWith(
                    fontSize: 11,
                    letterSpacing: 0.1 * 11,
                    color: i == at ? t.dim : t.faint,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  /// git's own words, not translated.
  ///
  /// A phone cannot tell a typo from a private repo from an unauthenticated `gh`, and a
  /// guess sends the operator the wrong way. The host appends the one fact it does know
  /// (`gh auth status`), and this prints both exactly as they arrived.
  Widget _failed(AppTokens t) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Clone failed',
              style: t.serif.copyWith(
                fontSize: 21,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.4,
                color: t.error,
              ),
            ),
            const SizedBox(height: 16),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
              decoration: BoxDecoration(
                color: t.raise,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                job.error ?? 'The machine gave no reason.',
                style: t.mono.copyWith(fontSize: 10.5, height: 1.6, color: t.muted),
              ),
            ),
            const SizedBox(height: 22),
            if (onRetry case final retry?)
              StartButton(
                onStart: retry,
                label: 'Try again',
                semanticsLabel: 'Try cloning ${job.name} again',
              ),
          ],
        ),
      );
}
