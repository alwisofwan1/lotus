import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import 'start_button.dart';

/// Nothing to show yet — **no host has named a single project or cell**.
///
/// Deliberately one state rather than two. Telling "no host paired" apart from
/// "paired but silent" needs the staleness rules `map.md` still calls fog, pending
/// `issues/02` — and guessing at them here would put a diagnosis on screen that
/// nothing has measured.
///
/// **The one route out of here is Diagnostics**, and it is here because its absence
/// was a real dead end: the switcher caret lives in `ProjectHeader`, this state
/// replaces the whole body, so an empty fleet left the only screen that explains
/// *why* it is empty completely unreachable. Found while trying to work out why a
/// paired phone was showing nothing — with no way to ask the app what it thought.
///
/// The wording stays neutral for the reason above: this row does not diagnose, it
/// offers the screen that does.
///
/// Not to be confused with `QuietProject`, which since ADR-14 covers the other empty
/// screen: a project that exists with nothing running in it. That one is a fact about
/// a healthy machine, and sending it here would send the operator to debug one.
class NothingYet extends StatelessWidget {
  const NothingYet({required this.onOpenDiagnostics, this.onAddProject, super.key});

  final VoidCallback onOpenDiagnostics;

  /// Offered here as the primary act, and only here.
  ///
  /// The class doc above explains why this screen refuses to diagnose, and that refusal
  /// still holds. What changed is narrower: once a host has **answered** and says it has
  /// no projects, the likeliest cause is not damage but a machine nobody has put anything
  /// on yet — and for that operator this is the only way forward there is. Diagnostics
  /// stays underneath it, unmoved.
  ///
  /// Null on a machine that will not take one, in which case this screen is exactly what
  /// it was before (`plans/pocket-vps-project-checkout/issues/03`).
  final VoidCallback? onAddProject;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Nothing here yet.',
              textAlign: TextAlign.center,
              style: t.ui.copyWith(fontSize: 13, color: t.muted),
            ),
            if (onAddProject case final add?) ...[
              const SizedBox(height: 22),
              // The app's own primary language — filled with `text`, inked with `bg`
              // (`start_button.dart`). Borrowed rather than re-drawn, so this screen
              // cannot grow a second idea of what a commit looks like.
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 230),
                child: StartButton(
                  onStart: add,
                  label: 'Add project',
                  semanticsLabel: 'Add a project to this machine',
                ),
              ),
            ],
            const SizedBox(height: 18),
            TextButton(
              onPressed: onOpenDiagnostics,
              child: Text(
                'DIAGNOSTICS',
                style: t.mono.copyWith(
                  fontSize: 11,
                  letterSpacing: 1.76,
                  color: t.dim,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
