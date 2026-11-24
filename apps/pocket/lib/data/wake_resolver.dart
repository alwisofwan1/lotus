import 'dart:async';

import '../models/cell.dart';
import 'fleet_store.dart';

/// Turns the pane id a wake-up names into the [Cell] to open — and waits for it.
///
/// Needed because a tap on a notification can *be* the launch: the fleet is still on
/// its way over the tailnet when the tap arrives, and asking the store once would
/// answer null for exactly the case the tap exists for. So this listens until the
/// pane shows up, bounded by [patience] so a pane that was closed meanwhile does not
/// leave a listener behind forever.
class WakeResolver {
  WakeResolver(this.fleet, {this.patience = const Duration(seconds: 15)});

  final FleetStore fleet;
  final Duration patience;

  Future<Cell?> resolve(String paneId) {
    final now = fleet.cellForPane(paneId);
    if (now != null) return Future.value(now);

    final found = Completer<Cell?>();
    late final Timer deadline;
    void look() {
      final cell = fleet.cellForPane(paneId);
      if (cell == null || found.isCompleted) return;
      found.complete(cell);
    }

    fleet.addListener(look);
    deadline = Timer(patience, () {
      if (!found.isCompleted) found.complete(null);
    });
    return found.future.whenComplete(() {
      fleet.removeListener(look);
      deadline.cancel();
    });
  }
}
