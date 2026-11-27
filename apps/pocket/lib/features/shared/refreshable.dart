import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';

/// Pull down to ask the machines again.
///
/// **Why a socket-driven app needs this at all.** Pocket's picture of a fleet arrives
/// over a WebSocket, so in the good case there is nothing to refresh — `fleet.changed`
/// already landed. The case that matters is the bad one, and it is the common one on a
/// phone: the socket died in a tunnel, the laptop slept, the tailnet dropped. Then the
/// screen is frozen and the app is *waiting for a backoff* it never told the operator
/// about. Pull-to-refresh is the one control that says "I am not waiting any more."
///
/// That is also why this wraps a real operation rather than a delay. The gesture is a
/// promise that something was asked; an indicator that spins for 800ms and hides is a
/// lie that teaches the operator the app is broken in a *new* way. Every use of this
/// widget hands it a future that resolves when a host has actually answered or actually
/// failed.
///
/// **It works on screens with nothing on them, which is the whole point.** An empty or
/// frozen screen is precisely when someone pulls, and a `Center` with a sentence in it
/// is not scrollable — so [Refreshable.fill] gives its child a viewport-tall scrollable
/// to be pulled from. Wrapping only the long lists would have shipped a gesture that
/// works everywhere except where it is needed.
class Refreshable extends StatelessWidget {
  /// For a child that is already its own scrollable — a `ListView`, usually.
  ///
  /// That child **must** set `physics: const AlwaysScrollableScrollPhysics()`, or a
  /// list shorter than the screen refuses to overscroll and the gesture silently does
  /// nothing on exactly the sparse fleets where it is most wanted.
  const Refreshable({required this.onRefresh, required this.child, super.key})
      : _fills = false;

  /// For a child that does not scroll: an empty state, a centred notice.
  const Refreshable.fill({required this.onRefresh, required this.child, super.key})
      : _fills = true;

  /// The real work. Resolves when the hosts have answered or failed — never earlier.
  final Future<void> Function() onRefresh;

  final Widget child;

  final bool _fills;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return RefreshIndicator(
      onRefresh: onRefresh,
      // `text` on the app floor, the same inverted pair every pressable thing in this
      // app uses. Not `waiting`: amber means *something is asked of you* (`MVP.md`),
      // and this is the operator asking the machine, which is the opposite direction.
      color: t.text,
      backgroundColor: Color.alphaBlend(t.raise, t.bg),
      // Below the default 40. The indicator drops from the top of the content area,
      // which on Home sits under a header that is already 60-odd pixels tall, and at
      // the default it appears to belong to the title rather than to the list.
      displacement: 28,
      strokeWidth: 2,
      child: _fills ? _scrollableFill() : child,
    );
  }

  /// A viewport-tall scroll view, so a screen with one sentence on it can still be
  /// pulled.
  ///
  /// The `ConstrainedBox` is what makes the gesture reachable anywhere on the screen
  /// rather than only over the text: without a minimum height the scrollable is as tall
  /// as the sentence, and everything below it is inert.
  Widget _scrollableFill() => LayoutBuilder(
        builder: (context, box) => SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: box.maxHeight),
            child: child,
          ),
        ),
      );
}
