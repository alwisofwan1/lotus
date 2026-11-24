import '../models/conversation.dart';
import '../models/host_id.dart';
import 'measurement_log.dart';

/// How much of a cell's conversation is held, and what may reclaim it.
///
/// Split out of `LiveConversation` when that file crossed this app's 300-line rule, and the
/// cut is where it is because everything here answers one question — *how much history does
/// this cell get to keep* — while what stays behind answers a different one: what the history
/// **is**. The store owns the turns; this owns the bound on them.
///
/// **Two bounds, and which one applies is decided by the operator.**
/// [maxParts] is what a cell earns by being live: the host pages at 500 and one page fits
/// whole. Trimming drops from the **front**, because the newest step is the one the operator
/// is waiting on — and the front is also exactly where scrolling up puts history. So a live
/// update would reclaim the page they had just asked for: measured 2026-09-08, one streaming
/// chunk took 200 parts and two whole turns off the top of the screen mid-read.
///
/// So the moment a cell is paged into, its bound becomes [maxHeld] — the hard ceiling — and
/// stays there until that history is dropped or replaced. **Not `maxParts + whatever arrived`,
/// which is the version this file shipped first and which grants no headroom at all:** a busy
/// cell is already at `maxParts`, so a cap of `maxParts + paged` equals what is held the
/// instant the page lands, and the very next step trims the page away again. One bound or the
/// other, never an arithmetic blend of the two.
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

  /// Remembers the entries a page brought in, so an overlapping page is not taken twice.
  ///
  /// Two `/transcript` reads can overlap — the host's ring against its file, or a repeated
  /// `oldestCursor` after a failed read — and the turn ids derived from them differ, so
  /// nothing downstream would catch it. That is the "one exchange drawn twice" failure, and
  /// on the delta lane this set is the only thing standing in front of it.
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
