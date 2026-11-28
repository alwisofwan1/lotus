import 'package:flutter/foundation.dart';

import '../core/clock.dart';
import '../core/secure_store.dart';
import '../models/host_id.dart';

class DoneMark {
  const DoneMark(this.turnId, this.at);
  final String turnId;
  final DateTime at;
}

/// Which agents the operator marked Done, and on which turn.
///
/// Kept on the phone: the host has no "finished" state for an agent. Done keeps the
/// session; a newer turn is a new task, so the mark stops counting without being erased.
class DoneMarks extends ChangeNotifier {
  DoneMarks(this.store, {this.now = systemClock});

  final SecureStore store;
  final Clock now;
  final Map<CellRef, DoneMark> _marks = {};

  static const String _prefix = 'done:';

  Future<void> load() async {
    final all = await store.readAll();
    for (final entry in all.entries) {
      if (!entry.key.startsWith(_prefix)) continue;
      final ref = _parse(entry.key.substring(_prefix.length));
      final bar = entry.value.lastIndexOf('|');
      final at = bar <= 0 ? null : int.tryParse(entry.value.substring(bar + 1));
      if (ref == null || at == null) continue;
      _marks[ref] = DoneMark(entry.value.substring(0, bar), DateTime.fromMillisecondsSinceEpoch(at));
    }
    notifyListeners();
  }

  DoneMark? markFor(CellRef ref) => _marks[ref];

  /// The mark, only while [lastTurn] is still the turn it was made on.
  DoneMark? doneFor(CellRef ref, {required String? lastTurn}) {
    final mark = _marks[ref];
    return mark != null && mark.turnId == lastTurn ? mark : null;
  }

  Future<void> mark(CellRef ref, String turnId) async {
    final mark = DoneMark(turnId, now());
    _marks[ref] = mark;
    notifyListeners();
    await store.write(_key(ref), '$turnId|${mark.at.millisecondsSinceEpoch}');
  }

  Future<void> clear(CellRef ref) async {
    if (_marks.remove(ref) == null) return;
    notifyListeners();
    await store.delete(_key(ref));
  }

  static String _key(CellRef ref) => '$_prefix${ref.host.value}/${ref.paneId}';

  static CellRef? _parse(String raw) {
    final slash = raw.indexOf('/');
    if (slash <= 0 || slash == raw.length - 1) return null;
    return CellRef(HostId(raw.substring(0, slash)), raw.substring(slash + 1));
  }
}
