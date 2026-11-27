import '../models/conversation.dart';
import '../models/host_id.dart';
import 'measurement_log.dart';

/// Keep paged history under a larger bound so live updates do not immediately evict it.
class HistoryWindow {
  HistoryWindow({
    required this.maxParts,
    required this.maxHeld,
    required this.measurements,
  });

  /// Parts per cell a live conversation is held to, before it has been paged into.
  final int maxParts;

  /// The ceiling no amount of scrolling up may pass, per cell.
  ///
  /// Every part held is a part rendered, and a pager walking backwards for an hour must not
  /// end up holding a whole conversation in a phone's memory.
  final int maxHeld;

  /// Where a dropped page is counted, on the key that answers "how much history fits before
  /// it starts being lost".
  final MeasurementLog measurements;

  /// Cells the operator has scrolled back into.
  final Set<CellRef> _paged = {};

  /// Entry keys already taken by a page, per cell — for the lane that keeps no entry list of
  /// its own to compare against. Bounded by [maxHeld], because a pager that walked backwards
  /// forever would otherwise leave this growing after the parts themselves were trimmed.
  final Map<CellRef, Set<String>> _taken = {};

  /// Records that this cell now holds history the operator asked for.
  void notePaged(CellRef ref) => _paged.add(ref);

  /// The cap this cell is held to right now.
  int capFor(CellRef ref) => _paged.contains(ref) ? maxHeld : maxParts;

  /// Whether a page carrying this entry has already been taken for this cell.
  bool alreadyTaken(CellRef ref, String key) => _taken[ref]?.contains(key) ?? false;

  /// Deduplicate overlapping pages whose derived turn IDs may differ.
  void noteTaken(CellRef ref, Iterable<String> keys) {
    final held = _taken.putIfAbsent(ref, () => {})..addAll(keys);
    if (held.length <= maxHeld) return;
    _taken[ref] = held.skip(held.length - maxHeld).toSet();
  }

  /// Drops the oldest turns until the cell is under its cap, in place.
  ///
  /// The last turn is never dropped, whatever the cap says: a cell rendered with nothing in
  /// it reads as a cell that has done nothing, which is a different claim.
  void trim(CellRef ref, List<Turn> held) {
    final cap = capFor(ref);
    var total = held.fold<int>(0, (n, t) => n + t.parts.length);
    while (total > cap && held.length > 1) {
      final dropped = held.removeAt(0);
      total -= dropped.parts.length;
      measurements.record(
        'transcript.dropped',
        dropped.parts.length,
        labels: {'paneId': ref.paneId, 'turnId': dropped.turnId},
      );
    }
  }

  /// Drops what a cell had earned. Called wherever its held history is replaced or dropped,
  /// so a raised cap can only ever describe pages that are still there.
  void forget(CellRef ref) {
    _paged.remove(ref);
    _taken.remove(ref);
  }

  void clear() {
    _paged.clear();
    _taken.clear();
  }
}
