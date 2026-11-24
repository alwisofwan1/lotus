import 'dart:async';

import 'package:flutter/material.dart';

import '../core/push_messages.dart';
import '../data/wake_resolver.dart';
import '../models/cell.dart';
import '../models/push_wake.dart';

/// What the app does with a wake-up that reaches it: a line while it is open, a screen
/// when one is tapped.
///
/// The host stays quiet for a pane this phone is already watching (`issues/04`), so a
/// wake-up that reaches a running app is about an agent on some *other* screen — worth
/// a sentence with a way there, not a silent drop. A tap resolves the pane against the
/// fleet, waiting for it when the tap was the launch.
class WakeRouting {
  WakeRouting({
    required PushMessages messages,
    required this.wakes,
    required this.messenger,
    required this.open,
  }) {
    _subs.add(messages.foreground.listen(banner));
    _subs.add(messages.opened.listen((wake) => unawaited(openWake(wake))));
  }

  final WakeResolver wakes;
  final GlobalKey<ScaffoldMessengerState> messenger;
  final void Function(Cell cell) open;
  final _subs = <StreamSubscription<PushWake>>[];

  void banner(PushWake wake) {
    messenger.currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text(wake.sentence),
        duration: const Duration(seconds: 6),
        action: SnackBarAction(label: 'OPEN', onPressed: () => unawaited(openWake(wake))),
      ));
  }

  Future<void> openWake(PushWake wake) async {
    final cell = await wakes.resolve(wake.paneId);
    if (cell == null) {
      messenger.currentState?.showSnackBar(
        SnackBar(content: Text('${wake.title} is no longer on any machine.')),
      );
      return;
    }
    open(cell);
  }

  void dispose() {
    for (final sub in _subs) {
      unawaited(sub.cancel());
    }
  }
}
