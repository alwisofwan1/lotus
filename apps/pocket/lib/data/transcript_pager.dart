import '../models/host_id.dart';
import '../models/transcript.dart';
import 'live_conversation.dart';

/// Walks a cell's transcript backwards, a page at a time.
///
/// **Its own concern, and that is why it is its own file.** The first version put the
/// cursor in [LiveConversation] and the fetch in `AgentRepository`, which left the two
/// halves of one behaviour in two places — and pushed both files past this app's
/// 300-line rule. Reading is not storing, and the repository is const-constructed and so
/// cannot hold a cursor at all.
///
/// Holds no entries. It knows how far back each cell has been read and how to ask for
/// the page before that; [LiveConversation] stays the only thing that holds a transcript.
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

  /// Fetches the page before what is held and puts it in front.
  ///
  /// Silent when there is nothing older, when one is already in flight, or when the read
  /// fails — a scroll that finds no more history is not an error to report, it is the top
  /// of the conversation.
  ///
  /// [from] is the cursor of the page already on screen, used only until this pager has
  /// walked at least once. It exists so the first scroll-up works without anyone having
  /// to push the initial cursor in — the page that read it already has it.
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
