import '../models/host_id.dart';
import '../models/transcript.dart';
import 'live_conversation.dart';

/// Keep paging cursors separate from the conversation store.
class TranscriptPager {
  TranscriptPager({required this.fetch});

  /// Reads one page. Injected rather than taking an api client, so a test drives this
  /// without a transport — and so the failure policy stays with the repository, which is
  /// where every other read's failure policy already lives.
  final Future<TranscriptSnapshot?> Function(CellRef ref, int before) fetch;

  /// How far back each cell has been read — the `oldestCursor` of the oldest page held.
  ///
  /// Absent means there is nothing older to ask for: either the start of the file, or a
  /// host that answered from its ring, which has no stable ground to walk backwards over.
  final Map<CellRef, int> _oldest = {};

  /// Whether a page is in flight, so a flick at the top asks once rather than a dozen
  /// times. Per cell: two pages of the pager can be alive at once.
  final Set<CellRef> _inFlight = {};

  /// Whether anything older can still be asked for.
  bool canLoadOlder(CellRef ref) => _oldest.containsKey(ref);

  /// Takes the cursor from a freshly-read page.
  ///
  /// Null or zero **clears** it: reaching the start of a file and a host that sends no
  /// cursor at all are both "nothing older to ask for", and both must stop a scroll-up
  /// from retrying forever.
  void noteCursor(CellRef ref, int? cursor) {
    if (cursor == null || cursor == 0) {
      _oldest.remove(ref);
    } else {
      _oldest[ref] = cursor;
    }
  }

  /// Drops what is known about cells outside [window], mirroring the store's own
  /// windowing so a long session does not accumulate cursors for cells nobody can reach.
  void follow(List<CellRef> window) {
    _oldest.removeWhere((ref, _) => !window.contains(ref));
    _inFlight.removeWhere((ref) => !window.contains(ref));
  }

  /// Ignore failed or duplicate page requests; use [from] for the first page.
  Future<void> loadOlder(CellRef ref, LiveConversation live, {int? from}) async {
    final cursor = _oldest[ref] ?? from;
    if (cursor == null || !_inFlight.add(ref)) return;
    try {
      final page = await fetch(ref, cursor);
      if (page == null) return;
      noteCursor(ref, page.oldestCursor);
      live.prependEntries(ref, page.entries);
    } finally {
      _inFlight.remove(ref);
    }
  }
}
