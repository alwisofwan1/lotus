import 'dart:async';

import 'package:flutter/material.dart';

import '../../models/cell.dart';
import '../shared/agent_mutations.dart';
import '../shared/tactile.dart';

/// Done: leave the page now, close the agent after [window] unless Undo is tapped.
///
/// The timer lives here, not in the page, because the page is gone a moment later; the
/// messenger belongs to the app, so Undo still works from the screen we land on.
void closeWithUndo({
  required ScaffoldMessengerState messenger,
  required AgentMutations mutations,
  required Cell cell,
  required int uncommitted,
  required VoidCallback leave,
  Duration window = const Duration(seconds: 5),
}) {
  Tactile.sent();
  final pending = Timer(window, () => unawaited(mutations.closeAfterUndo(messenger, cell)));
  leave();
  final left = uncommitted > 0
      ? ' · $uncommitted ${uncommitted == 1 ? 'file' : 'files'} not committed'
      : '';
  messenger
    ..removeCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text('Closed ${cell.title}$left'),
      duration: window,
      // An action would otherwise keep the bar up until dismissed; Undo is a fixed window.
      persist: false,
      action: SnackBarAction(label: 'Undo', onPressed: pending.cancel),
    ));
}
