import 'package:flutter/foundation.dart';

import '../core/clock.dart';
import '../core/secure_store.dart';
import '../models/cell.dart';
import '../models/host_id.dart';

/// Which agents the operator has opened since they last finished — so Home can mark
/// the ones that came back with something while nobody was looking.
///
/// **What "finished" means here is the fleet's word, not ours.** `turn == idle` with a
/// `turnAgeMs` says the agent stopped, and when; an agent is *unread* when that moment
/// is later than the last time this phone opened it. A runner that never reports a turn
/// (Codex, a Claude whose hooks do not reach it) can never be unread — the phone does
/// not know it finished, and guessing would light rows up at random.
///
/// Persisted in the same store as everything else this app remembers, keyed per cell,
/// so a mark survives a relaunch: the whole point is the operator who put the phone down.
class SeenMarks extends ChangeNotifier {
  SeenMarks(this.store, {this.now = systemClock});

  final SecureStore store;
  final Clock now;
  final Map<CellRef, DateTime> _openedAt = {};

  static const String _prefix = 'seen:';

  /// Reads every mark back. Called once at boot; the map is the truth afterwards.
  Future<void> load() async {
    final all = await store.readAll();
    for (final entry in all.entries) {
      if (!entry.key.startsWith(_prefix)) continue;
      final ref = _parse(entry.key.substring(_prefix.length));
      final at = int.tryParse(entry.value);
      if (ref != null && at != null) _openedAt[ref] = DateTime.fromMillisecondsSinceEpoch(at);
    }
    notifyListeners();
  }

  /// The operator is looking at this agent now.
  Future<void> markOpened(CellRef ref) async {
    final at = now();
    _openedAt[ref] = at;
    notifyListeners();
    await store.write(_key(ref), at.millisecondsSinceEpoch.toString());
  }

  DateTime? openedAt(CellRef ref) => _openedAt[ref];

  /// Finished since it was last opened. Never true for a cell whose finish the fleet
  /// cannot date — see the class doc for why that is the honest answer.
  bool isUnread(Cell cell) {
    if (!cell.isIdle) return false;
    final age = cell.turnAgeMs;
    if (age == null) return false;
    final finishedAt = now().subtract(Duration(milliseconds: age));
    final opened = _openedAt[cell.ref];
    return opened == null || finishedAt.isAfter(opened);
  }

  static String _key(CellRef ref) => '$_prefix${ref.host.value}/${ref.paneId}';

  static CellRef? _parse(String raw) {
    final slash = raw.indexOf('/');
    if (slash <= 0 || slash == raw.length - 1) return null;
    return CellRef(HostId(raw.substring(0, slash)), raw.substring(slash + 1));
  }
}
