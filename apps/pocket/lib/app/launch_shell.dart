import 'package:flutter/material.dart';

import '../data/intro_seen.dart';
import '../features/onboarding/intro_pages.dart';
import '../hosts/credentials.dart';
import 'launch_route.dart';
import 'splash_gate.dart';

/// Everything between the OS launch window and the screen the operator wanted.
///
/// Split out of `PocketApp` because it is one coherent job — hold the splash, then
/// pick among three first screens — with its own inputs and its own rule about their
/// precedence. `PocketApp` keeps what it was already doing: the theme, the lifecycle
/// observer, and every route pushed *after* this one.
///
/// It listens to [credentials] rather than being told when to rebuild, which is what
/// makes the swap work without a flag: pairing calls `Credentials.remember`, that
/// notifies, and the move from the pairing form to the project index is the same
/// rebuild that stores the token. Unpairing the last machine comes back by the same
/// path.
///
/// **The intro is built here rather than injected**, unlike the other two. It is the
/// only one of the three whose *exit* is this file's business — when the bit is
/// written is the rule below — and handing that out as a callback would put the rule
/// in whichever file happened to construct the screen.
class LaunchShell extends StatefulWidget {
  const LaunchShell({
    required this.credentials,
    required this.introSeen,
    required this.pairing,
    required this.projects,
    super.key,
  });

  final Credentials credentials;

  /// Read on every rebuild, and written in exactly one place: [_finishIntro]. Not a
  /// [Listenable], because that one write is followed by a `setState` beside it.
  final IntroSeen introSeen;

  final WidgetBuilder pairing;
  final WidgetBuilder projects;

  @override
  State<LaunchShell> createState() => _LaunchShellState();
}

class _LaunchShellState extends State<LaunchShell> {
  @override
  Widget build(BuildContext context) => SplashGate(
        // Known before this widget exists: `CompositionRoot.boot` awaited the
        // Keystore and `main()` awaited that. Nothing here is a guess about work
        // still in flight, which is what lets the line be this specific.
        line: launchLine(widget.credentials.devices.length),
        builder: (context) => ListenableBuilder(
          listenable: widget.credentials,
          builder: (context, _) => switch (launchRoute(
            paired: widget.credentials.devices.isNotEmpty,
            introSeen: widget.introSeen.isSeen,
          )) {
            LaunchRoute.intro => IntroPages(onDone: _finishIntro),
            LaunchRoute.pairing => widget.pairing(context),
            LaunchRoute.projects => widget.projects(context),
          },
        ),
      );

  /// Skipped or finished — the same answer, and recorded **before** the pairing form
  /// appears rather than after a successful pair. A pairing abandoned halfway would
  /// otherwise bring three explanatory panes back on the next launch, at the moment
  /// the operator is most certain they have already read them.
  Future<void> _finishIntro() async {
    await widget.introSeen.markSeen();
    if (mounted) setState(() {});
  }
}
