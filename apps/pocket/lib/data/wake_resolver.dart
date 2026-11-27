import 'dart:async';

import '../models/cell.dart';
import 'fleet_store.dart';

/// Wait for fleet hydration on cold-start notification taps, with a bounded timeout.
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
