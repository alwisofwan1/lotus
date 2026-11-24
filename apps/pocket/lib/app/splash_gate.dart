import 'dart:async';

import 'package:flutter/material.dart';

import '../features/splash/splash_screen.dart';

/// Holds [SplashScreen] up for one bounded moment, then hands over.
///
/// **It takes a duration and nothing else, and that is a decision rather than a
/// simplification.** The first draft of this took a `Future ready` so the splash could
/// wait for boot — and boot turned out to be already finished: `CompositionRoot.boot`
/// awaits `credentials.load()` and `seenMarks.load()` itself, and `main()` awaits
/// *that* before `runApp`. Every local fact this app has is known before the first
/// Flutter frame exists. The only thing still outstanding at this point is
/// `root.start()`, the sockets — and `main()` pointedly does not await those, because
/// a sleeping host retries for as long as it stays asleep and holding the first frame
/// for it would put the whole screen behind the slowest machine (R-11).
///
/// So a splash here can only ever be waiting for its own animation. Giving it a future
/// to hold would have been a seam whose only possible use is breaking R-11, on the one
/// screen where breaking it is least visible. There is no such seam.
///
/// [hold] is the bloom in [SplashScreen] plus a beat: long enough that the mark reads
/// as opening rather than appearing, short enough that an operator checking whether an
/// agent needs them does not notice paying it.
///
/// This lives in `app/` rather than beside the screen it shows because it is timing and
/// routing; `features/` renders (README, Layout).
class SplashGate extends StatefulWidget {
  const SplashGate({
    required this.builder,
    required this.line,
    this.hold = defaultHold,
    super.key,
  });

  /// 820 ms: the eight staggered petals and the core finish at 760 ms, and the
  /// wordmark needs the rest. Below ~450 ms a splash reads as a flicker, which is
  /// worse than not having one.
  static const Duration defaultHold = Duration(milliseconds: 820);

  /// Built **once**, when the gate opens — not eagerly behind the splash. The index
  /// subscribes to the fleet when it mounts, and mounting it twice would open that
  /// subscription twice.
  final WidgetBuilder builder;

  /// One short, true, lower-case line — `2 machines · dialing`, `no machine paired`.
  /// Both are known synchronously; see [SplashScreen.line] for why it is never a
  /// percentage.
  final String line;

  final Duration hold;

  @override
  State<SplashGate> createState() => _SplashGateState();
}

class _SplashGateState extends State<SplashGate> {
  bool _open = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer(widget.hold, () {
      if (mounted) setState(() => _open = true);
    });
  }

  @override
  void dispose() {
    // A timer that outlives its widget calls `setState` on a dead element, and on the
    // launch path that lands as a crash on the only screen there is.
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedSwitcher(
        // A cross-fade, not a push. Both sides stand on the same `bg`, so only the ink
        // moves — which reads as one room rather than two pages.
        duration: const Duration(milliseconds: 220),
        switchInCurve: Curves.easeInOut,
        switchOutCurve: Curves.easeInOut,
        child: _open
            ? KeyedSubtree(key: const ValueKey('beyond'), child: widget.builder(context))
            : SplashScreen(key: const ValueKey('splash'), line: widget.line),
      );
}
